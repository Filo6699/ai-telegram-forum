import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { resolveOutgoing } from "./media.ts";
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
- You are the top-level session. Subagents must return their findings to you;
  they must not use this tool to contact the person directly.
- Do NOT narrate your progress. Tool activity is already shown to them as a live
  status line, updated automatically.
- Write like a chat, not a report: a few lines, no headings, no recaps of what
  you just did. Markdown works — **bold**, \`code\`, and fenced code blocks.
- Telegram has NO tables. Never send one: use a short list, \`Label: value\`
  lines, or a fenced code block if the columns really matter.
- One call = one finished message = one notification on their phone. Batch related
  thoughts into a single call instead of firing several in a row.
- You can attach local files with the \`files\` argument — screenshots, images,
  logs, PDFs, an artifact you just produced. Paths are relative to your working
  directory. Images arrive as pictures, everything else as a file; your text
  rides along as the caption. Attach the thing itself rather than describing it,
  but don't attach source files they can already read.`;

export interface TgChannel {
  server: ReturnType<typeof createSdkMcpServer>;
  /** Deliver a message from the owning top-level session. */
  send(args: TgSendArgs): Promise<TgSendResult>;
  /** Messages the agent posted this turn. Zero means it never spoke. */
  readonly sent: number;
  /** Called at the start of every turn — `sent` counts the current turn only. */
  resetSent(): void;
}

export interface TgSendArgs {
  text?: string;
  files?: string[];
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const failure = (s: string) => ({ ...text(s), isError: true as const });
export type TgSendResult = ReturnType<typeof text> | ReturnType<typeof failure>;

/** Whether a send call delivered at least its text or one attachment. */
export function tgSendDelivered(result: TgSendResult): boolean {
  return (
    !("isError" in result) ||
    result.content[0]?.text.includes("text was sent on its own") === true
  );
}

/** Provider-neutral Telegram delivery used by the broker and Claude's
 * in-process MCP server. Codex's stdio MCP server is deliberately side-effect
 * free because Codex inherits it into subagents. */
export async function runTgSend(
  out: TopicRenderer,
  cwd: string,
  args: TgSendArgs,
): Promise<ReturnType<typeof text> | ReturnType<typeof failure>> {
  const body = args.text ?? "";
  const paths = args.files ?? [];
  if (!body.trim() && !paths.length) return failure("refused: empty message");

  if (!paths.length) {
    const id = await out.sendText(body);
    return id === null
      ? failure("delivery failed — Telegram rejected every rendering")
      : text(`sent (id: ${id})`);
  }

  const { files, errors } = resolveOutgoing(cwd, paths);
  if (!files.length) {
    const id = body.trim() ? await out.sendText(body) : null;
    return failure(
      `no file could be attached:\n${errors.join("\n")}` +
        (id !== null ? "\n(the text was sent on its own)" : ""),
    );
  }

  const { ids, captioned, failed } = await out.sendMedia(files, body);
  if (body.trim() && !captioned) {
    const id = await out.sendText(body);
    if (id !== null) ids.push(id);
  }
  if (!ids.length) return failure("delivery failed — Telegram rejected the upload");

  const notes = [...errors, ...failed.map((f) => `${f.path}: upload rejected`)];
  return text(
    `sent (${files.length - failed.length} file(s), id: ${ids.at(-1)})` +
      (notes.length ? `\nnot attached:\n${notes.join("\n")}` : ""),
  );
}

/**
 * An in-process MCP server that lets the agent post into one specific topic.
 * `cwd` is the session's working directory — what a relative attachment path
 * is relative to.
 */
export function createTgChannel(out: TopicRenderer, cwd: string): TgChannel {
  let sent = 0;

  const send = (args: TgSendArgs): Promise<TgSendResult> => runTgSend(out, cwd, args);

  const server = createSdkMcpServer({
    name: SERVER_NAME,
    version: "1.0.0",
    // The topic is bound here, not passed by the model: an agent can't address
    // a chat or a thread it wasn't started for.
    tools: [
      tool(
        "send",
        "Send a message to the person you are talking to on Telegram, optionally with files attached. This is the only way to reach them — your turn text is not delivered. Markdown is supported, except tables — Telegram cannot render them.",
        {
          text: z
            .string()
            .default("")
            .describe("Message body. Markdown, no tables; keep it short."),
          files: z
            .array(z.string())
            .optional()
            .describe(
              "Local paths to attach, relative to your working directory or absolute. Images and video are shown inline, anything else is sent as a file. Max 50 MB each.",
            ),
        },
        async (args) => {
          const result = await send(args);
          if (tgSendDelivered(result)) sent++;
          return result;
        },
        { alwaysLoad: true },
      ),
    ],
  });

  return {
    server,
    send,
    get sent() {
      return sent;
    },
    resetSent() {
      sent = 0;
    },
  };
}
