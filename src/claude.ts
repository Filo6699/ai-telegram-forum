import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Bot } from "grammy";
import { cfg } from "./config.ts";
import { TopicRenderer } from "./render.ts";

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

/**
 * Run one conversational turn for a topic. Collects assistant text (and tool
 * activity markers), posts it to the topic once the turn is complete, and
 * returns the (possibly new) session id to persist. Pass `resume` to continue
 * an existing session.
 */
export async function runTurn(
  bot: Bot,
  threadId: number,
  cwd: string,
  prompt: string,
  resume?: string | null,
): Promise<TurnResult> {
  const out = new TopicRenderer(bot, cfg.chatId, threadId);
  let sessionId: string | undefined = resume ?? undefined;
  let ok = false;
  const usage = { inTokens: 0, outTokens: 0, costUsd: 0 };

  try {
    for await (const msg of query({
      prompt,
      options: {
        cwd,
        model: cfg.model,
        ...(resume ? { resume } : {}),
        ...permissionOptions(),
      },
    })) {
      switch (msg.type) {
        case "system":
          if (msg.subtype === "init") sessionId = msg.session_id;
          break;

        // Final assistant messages are the source of truth for the reply.
        case "assistant": {
          for (const block of msg.message.content) {
            if (block.type === "text") out.push(block.text);
            else if (block.type === "tool_use") out.push(`\n\n🔧 ${block.name}\n`);
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
          if (!usage.inTokens && !usage.outTokens) {
            const m = usageFromModels((msg as any).modelUsage);
            usage.inTokens = m.inTokens;
            usage.outTokens = m.outTokens;
          }
          // Last-resort text: if no assistant message carried the reply, the
          // result still holds it in full.
          if (ok && out.isEmpty) {
            const text = (msg as any).result;
            if (typeof text === "string") out.push(text);
          }
          if (!ok) {
            out.push(`\n\n⚠️ ${msg.subtype}: ${(msg as any).error ?? ""}`);
          }
          break;
        }
      }
    }
  } catch (err) {
    out.push(`\n\n❌ ${String(err)}`);
    console.error(`[claude] turn failed on thread ${threadId}:`, err);
  } finally {
    await out.send();
  }

  return { sessionId, ok, usage };
}
