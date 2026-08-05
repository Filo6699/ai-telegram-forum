import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { TopicRenderer } from "./render.ts";

const SERVER_NAME = "tg";

/** Fully-qualified name the model sees — must be in `allowedTools` to be usable. */
export const TG_SEND_TOOL = `mcp__${SERVER_NAME}__send`;

/**
 * Appended to the system prompt. Without it the agent writes its answer as
 * normal turn text, which nobody reads: the transcript lives in this process,
 * not in Telegram.
 */
export const TG_SYSTEM_PROMPT = `You are talking to a person over Telegram, from within a forum topic.

Your turn text is NOT delivered to them. The \`${TG_SEND_TOOL}\` tool is the only
way to say anything — if you never call it, they see nothing.

- Send a message when you have something worth their attention: the answer, a
  question you're blocked on, or a warning. Then keep working.
- Do NOT narrate your progress. Tool activity is already shown to them as a live
  status line, updated automatically.
- Write like a chat, not a report: a few lines, no headings, no recaps of what
  you just did. Markdown works — **bold**, \`code\`, and fenced code blocks.
- One call = one message = one notification on their phone. Batch related
  thoughts into a single call instead of firing several in a row.`;

export interface TgChannel {
  server: ReturnType<typeof createSdkMcpServer>;
  /** Messages the agent posted this turn. Zero means it never spoke. */
  readonly sent: number;
}

/** An in-process MCP server that lets the agent post into one specific topic. */
export function createTgChannel(out: TopicRenderer): TgChannel {
  let sent = 0;

  const server = createSdkMcpServer({
    name: SERVER_NAME,
    version: "1.0.0",
    // The topic is bound here, not passed by the model: an agent can't address
    // a chat or a thread it wasn't started for.
    tools: [
      tool(
        "send",
        "Send a message to the person you are talking to on Telegram. This is the only way to reach them — your turn text is not delivered. Markdown is supported.",
        { text: z.string().describe("Message body. Markdown; keep it short.") },
        async ({ text }) => {
          if (!text.trim()) {
            return {
              content: [{ type: "text" as const, text: "refused: empty message" }],
              isError: true,
            };
          }
          const id = await out.sendText(text);
          if (id === null) {
            return {
              content: [
                { type: "text" as const, text: "delivery failed — Telegram rejected every rendering" },
              ],
              isError: true,
            };
          }
          sent++;
          return { content: [{ type: "text" as const, text: `sent (id: ${id})` }] };
        },
        { alwaysLoad: true },
      ),
    ],
  });

  return {
    server,
    get sent() {
      return sent;
    },
  };
}
