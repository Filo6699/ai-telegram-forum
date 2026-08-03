import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Bot } from "grammy";
import { cfg } from "./config.ts";
import { StreamRenderer } from "./stream.ts";

export interface TurnResult {
  sessionId: string | undefined;
  ok: boolean;
  usage: { inTokens: number; outTokens: number; costUsd: number };
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
    allowedTools: cfg.allowedTools,
    canUseTool: async (name: string, input: Record<string, unknown>) => {
      if (!cfg.allowedTools.includes(name)) {
        return { behavior: "deny" as const, message: `Tool ${name} not allowed` };
      }
      if (name === "Bash" && isDangerousBash(input)) {
        return { behavior: "deny" as const, message: "Blocked destructive command" };
      }
      return { behavior: "allow" as const, updatedInput: input };
    },
  };
}

/**
 * Run one conversational turn for a topic. Streams assistant text (and tool
 * activity markers) into the topic and returns the (possibly new) session id
 * to persist. Pass `resume` to continue an existing session.
 */
export async function runTurn(
  bot: Bot,
  threadId: number,
  cwd: string,
  prompt: string,
  resume?: string | null,
): Promise<TurnResult> {
  const stream = new StreamRenderer(bot, cfg.chatId, threadId);
  let sessionId: string | undefined = resume ?? undefined;
  let ok = false;
  const usage = { inTokens: 0, outTokens: 0, costUsd: 0 };

  try {
    for await (const msg of query({
      prompt,
      options: {
        cwd,
        model: cfg.model,
        includePartialMessages: true,
        ...(resume ? { resume } : {}),
        ...permissionOptions(),
      },
    })) {
      switch (msg.type) {
        case "system":
          if (msg.subtype === "init") sessionId = msg.session_id;
          break;

        case "stream_event": {
          const ev = msg.event;
          if (
            ev.type === "content_block_delta" &&
            ev.delta.type === "text_delta"
          ) {
            stream.push(ev.delta.text);
          } else if (
            ev.type === "content_block_start" &&
            ev.content_block.type === "tool_use"
          ) {
            stream.push(`\n\n🔧 ${ev.content_block.name}\n`);
          }
          break;
        }

        case "result": {
          sessionId = msg.session_id;
          ok = msg.subtype === "success";
          const u = (msg as any).usage ?? {};
          usage.inTokens =
            (u.input_tokens ?? 0) +
            (u.cache_read_input_tokens ?? 0) +
            (u.cache_creation_input_tokens ?? 0);
          usage.outTokens = u.output_tokens ?? 0;
          usage.costUsd = (msg as any).total_cost_usd ?? 0;
          if (!ok) {
            stream.push(`\n\n⚠️ ${msg.subtype}: ${(msg as any).error ?? ""}`);
          }
          break;
        }
      }
    }
  } catch (err) {
    stream.push(`\n\n❌ ${String(err)}`);
    console.error(`[claude] turn failed on thread ${threadId}:`, err);
  } finally {
    await stream.finish();
  }

  return { sessionId, ok, usage };
}
