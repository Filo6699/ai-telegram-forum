import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { EffortLevel as ClaudeEffortLevel } from "@anthropic-ai/claude-agent-sdk";
import type { Bot } from "grammy";
import { cfg } from "./config.ts";
import type { Effort } from "./effort.ts";
import type { Model } from "./model.ts";
import { authorizeTool } from "./permission.ts";
import { TG_SEND_TOOL, TG_SYSTEM_PROMPT, type TgChannel } from "./tg-tools.ts";

export interface Usage {
  inTokens: number;
  outTokens: number;
  /** null means the provider did not report a price. */
  costUsd: number | null;
}

/** Tools the agent may use without asking. Talking to the user is never gated. */
export const autoAllowed = [...cfg.allowedTools, TG_SEND_TOOL];

function permissionOptions(bot: Bot, threadId: number) {
  if (cfg.permission === "bypass") {
    return {
      permissionMode: "bypassPermissions" as const,
      allowDangerouslySkipPermissions: true,
    };
  }
  // "auto": ALLOWED_TOOLS run unattended; anything else asks in the topic and
  // waits for a button. A command flagged as destructive always asks, even if
  // its tool is allowlisted or was granted a blanket approval.
  return {
    permissionMode: "default" as const,
    allowedTools: autoAllowed,
    canUseTool: async (name: string, input: Record<string, unknown>) => {
      const allowed = await authorizeTool(bot, threadId, name, input);
      return allowed
        ? { behavior: "allow" as const, updatedInput: input }
        : { behavior: "deny" as const, message: `Denied by the user over Telegram` };
    },
  };
}

/** Everything the SDK needs to run one topic's session. */
export function queryOptions(opts: {
  bot: Bot;
  threadId: number;
  cwd: string;
  resume: string | null;
  effort: Effort;
  model: Model;
  channel: TgChannel;
  onStderr: (data: string) => void;
}): Options {
  return {
    cwd: opts.cwd,
    // Nothing picked for this topic — the configured MODEL is the default.
    model: opts.model ?? cfg.claudeModel,
    // Unset means unset: with no `effort` the CLI resolves its own default from
    // settings and the model, which is the default we advertise.
    ...(opts.effort ? { effort: opts.effort as ClaudeEffortLevel } : {}),
    mcpServers: { tg: opts.channel.server },
    systemPrompt: { type: "preset", preset: "claude_code", append: TG_SYSTEM_PROMPT },
    stderr: opts.onStderr,
    // The SDK would stamp every record with `entrypoint: "sdk-ts"`, and the CLI's
    // /resume picker hides those — a topic's session would be invisible in the
    // terminal it runs in. Claim "cli" so the picker lists it like any other.
    env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "cli" } as Record<string, string>,
    ...(opts.resume ? { resume: opts.resume } : {}),
    ...permissionOptions(opts.bot, opts.threadId),
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
    costUsd: typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : null,
  };
  if (!usage.inTokens && !usage.outTokens) {
    const m = usageFromModels(msg.modelUsage);
    usage.inTokens = m.inTokens;
    usage.outTokens = m.outTokens;
  }
  return usage;
}
