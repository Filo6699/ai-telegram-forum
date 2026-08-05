import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { cfg } from "./config.ts";
import { TG_SEND_TOOL, TG_SYSTEM_PROMPT, type TgChannel } from "./tg-tools.ts";

export interface Usage {
  inTokens: number;
  outTokens: number;
  costUsd: number;
}

// Obviously destructive shell patterns rejected even for allowed Bash in "auto"
// mode. Defense-in-depth, not a sandbox — point the bot at trusted dirs.
const DANGEROUS_BASH = [
  /\brm\s+-[a-z]*r[a-z]*f\b/i, // rm -rf and friends
  /\bmkfs\b/i,
  /\bdd\b[^\n]*\bof=\/dev\//i,
  /\s>\s*\/dev\/(sd|nvme|disk)/i,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;/, // fork bomb
  /\bchmod\s+-R\s+0*777\s+\//,
  /\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(sh|bash)\b/i, // curl | sh
  /\bshutdown\b|\breboot\b|\bhalt\b/i,
];

function isDangerousBash(input: Record<string, unknown>): boolean {
  const cmd = typeof input.command === "string" ? input.command : "";
  return DANGEROUS_BASH.some((re) => re.test(cmd));
}

/** Tools the agent may use without asking. Talking to the user is never gated. */
export const autoAllowed = [...cfg.allowedTools, TG_SEND_TOOL];

function permissionOptions() {
  if (cfg.permission === "bypass") {
    return {
      permissionMode: "bypassPermissions" as const,
      allowDangerouslySkipPermissions: true,
    };
  }
  // "auto": only ALLOWED_TOOLS are approved; everything else is denied. This
  // never blocks waiting for input, which matters in a headless bot.
  return {
    permissionMode: "default" as const,
    allowedTools: autoAllowed,
    canUseTool: async (name: string, input: Record<string, unknown>) => {
      if (!autoAllowed.includes(name)) {
        return { behavior: "deny" as const, message: `Tool ${name} not allowed` };
      }
      if (name === "Bash" && isDangerousBash(input)) {
        return { behavior: "deny" as const, message: "Blocked destructive command" };
      }
      return { behavior: "allow" as const, updatedInput: input };
    },
  };
}

/** Everything the SDK needs to run one topic's session. */
export function queryOptions(opts: {
  cwd: string;
  resume: string | null;
  channel: TgChannel;
  onStderr: (data: string) => void;
}): Options {
  return {
    cwd: opts.cwd,
    model: cfg.model,
    mcpServers: { tg: opts.channel.server },
    systemPrompt: { type: "preset", preset: "claude_code", append: TG_SYSTEM_PROMPT },
    stderr: opts.onStderr,
    ...(opts.resume ? { resume: opts.resume } : {}),
    ...permissionOptions(),
  };
}

/** Sum per-model usage; used when the result's flat `usage` comes back empty. */
function usageFromModels(modelUsage: Record<string, any> | undefined) {
  const acc = { inTokens: 0, outTokens: 0 };
  for (const u of Object.values(modelUsage ?? {})) {
    acc.inTokens +=
      (u?.inputTokens ?? 0) +
      (u?.cacheReadInputTokens ?? 0) +
      (u?.cacheCreationInputTokens ?? 0);
    acc.outTokens += u?.outputTokens ?? 0;
  }
  return acc;
}

/** Pull a turn's cost out of a `result` message, whichever shape it arrived in. */
export function readUsage(msg: any): Usage {
  const u = msg.usage ?? {};
  const usage: Usage = {
    inTokens:
      (u.input_tokens ?? 0) +
      (u.cache_read_input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0),
    outTokens: u.output_tokens ?? 0,
    costUsd: msg.total_cost_usd ?? 0,
  };
  if (!usage.inTokens && !usage.outTokens) {
    const m = usageFromModels(msg.modelUsage);
    usage.inTokens = m.inTokens;
    usage.outTokens = m.outTokens;
  }
  return usage;
}
