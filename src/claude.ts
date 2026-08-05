import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Bot } from "grammy";
import { cfg } from "./config.ts";
import { fmtTokens, humanMs } from "./fmt.ts";
import { TopicRenderer } from "./render.ts";
import { TurnStatus } from "./status.ts";
import { createTgChannel, TG_SEND_TOOL, TG_SYSTEM_PROMPT } from "./tg-tools.ts";

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
  // never blocks waiting for input, which matters in a headless bot. Talking to
  // the user is never gated — denying it would leave the topic silent.
  const allowed = [...cfg.allowedTools, TG_SEND_TOOL];
  return {
    permissionMode: "default" as const,
    allowedTools: allowed,
    canUseTool: async (name: string, input: Record<string, unknown>) => {
      if (!allowed.includes(name)) {
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
 * Run one conversational turn for a topic.
 *
 * The agent speaks for itself through `mcp__tg__send`, so nothing here relays
 * the transcript: tool calls only bump the live status line, and assistant text
 * is buffered purely as a safety net for a turn that ended without the agent
 * ever calling the tool. Returns the (possibly new) session id to persist; pass
 * `resume` to continue an existing session.
 */
export async function runTurn(
  bot: Bot,
  threadId: number,
  cwd: string,
  prompt: string,
  resume?: string | null,
): Promise<TurnResult> {
  const out = new TopicRenderer(bot, cfg.chatId, threadId);
  const channel = createTgChannel(out);
  const status = new TurnStatus(out);
  await status.start();

  let sessionId: string | undefined = resume ?? undefined;
  let ok = false;
  const usage = { inTokens: 0, outTokens: 0, costUsd: 0 };

  // Failures bypass the "did the agent speak?" logic below — they always get
  // posted, even on a turn where the agent already sent messages.
  let failure: string | null = null;

  // The SDK's own error is just an exit code; the reason (auth, terms, bad
  // model, …) only shows up on the child's stderr.
  let stderr = "";

  try {
    for await (const msg of query({
      prompt,
      options: {
        cwd,
        model: cfg.model,
        mcpServers: { tg: channel.server },
        systemPrompt: { type: "preset", preset: "claude_code", append: TG_SYSTEM_PROMPT },
        stderr: (data: string) => {
          stderr += data;
          console.error(`[claude:${threadId}] ${data.trimEnd()}`);
        },
        ...(resume ? { resume } : {}),
        ...permissionOptions(),
      },
    })) {
      switch (msg.type) {
        case "system":
          if (msg.subtype === "init") sessionId = msg.session_id;
          break;

        case "assistant": {
          for (const block of msg.message.content) {
            if (block.type === "text") out.push(block.text);
            // Posting the reply is a tool call like any other, but it isn't
            // work the user asked for — keep it out of the count.
            else if (block.type === "tool_use" && block.name !== TG_SEND_TOOL) {
              status.tool(block.name);
            }
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
          if (!ok) failure = `⚠️ ${msg.subtype}: ${(msg as any).error ?? ""}`;
          break;
        }
      }
    }
  } catch (err) {
    const detail = stderr.trim().split("\n").filter(Boolean).slice(-5).join("\n");
    failure = `❌ ${String(err)}` + (detail ? `\n\n\`\`\`\n${detail}\n\`\`\`` : "");
    console.error(`[claude] turn failed on thread ${threadId}:`, err);
  } finally {
    // The agent stayed silent — fall back to whatever text the turn produced,
    // rather than leaving the topic with nothing but a summary.
    if (channel.sent === 0) await out.send();
    else out.clear();
    if (failure) await out.sendText(failure);
    await status.finish(summarize(ok && !failure, status, usage));
  }

  return { sessionId, ok, usage };
}

/** The one line that replaces the live status when a turn ends. */
function summarize(
  ok: boolean,
  status: TurnStatus,
  usage: { inTokens: number; outTokens: number; costUsd: number },
): string {
  const parts = [ok ? "✅" : "⚠️", humanMs(status.elapsedMs)];
  if (status.toolCalls > 0) parts.push(`🔧 ${status.toolCalls}`);
  if (usage.inTokens || usage.outTokens) {
    parts.push(`${fmtTokens(usage.inTokens)}↑ ${fmtTokens(usage.outTokens)}↓`);
  }
  if (usage.costUsd > 0) parts.push(`$${usage.costUsd.toFixed(4)}`);
  return parts.join(" · ");
}
