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
- Native user-input tools also deliver their questions to Telegram. Use them
  for structured questions without sending a duplicate question through this
  tool. A Telegram reply is tied to the question it answers.
- You are the top-level session. Subagents must return their findings to you;
  they must not use this tool to contact the person directly.
- Subagents are your own tooling. Don't announce that you launched them or
  that you're waiting on them. When their work matters, report the result as
  your own finding, not as "the subagent's report".
- A harness reminder that the user hasn't heard from you is not a reason to
  send when the communication preference is off.
- Follow the Telegram communication preference attached to incoming messages
  for progress updates. If absent, do not narrate progress. Tool activity is
  already shown as a live status line, updated automatically.
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
  but don't attach source files they can already read.
- If an attachment fails, tell the user immediately. Do not split the files or
  retry them in smaller batches to work around the failure.`;

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
const failure = (s: string, delivered = false) => ({
  ...text(s),
  isError: true as const,
  _meta: { delivered },
});
export type TgSendResult = ReturnType<typeof text> | ReturnType<typeof failure>;

export const TG_ATTACHMENT_FAILURE_GUIDANCE =
  "Tell the user immediately that the attachment(s) could not be sent. " +
  "Do not split the files or retry them in smaller batches.";

/** Whether a send call delivered at least its text or one attachment. */
export function tgSendDelivered(result: TgSendResult): boolean {
  return (
    !("isError" in result) ||
    result._meta?.delivered === true
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
        (id !== null ? "\n(the text was sent on its own)" : "") +
        `\n${TG_ATTACHMENT_FAILURE_GUIDANCE}`,
      id !== null,
    );
  }

  const { ids, captioned, failed } = await out.sendMedia(files, body);
  if (body.trim() && !captioned) {
    const id = await out.sendText(body);
    if (id !== null) ids.push(id);
  }
  const notes = [...errors, ...failed.map((f) => `${f.path}: upload rejected`)];
  const status = ids.length
    ? `sent (${files.length - failed.length} file(s), id: ${ids.at(-1)})`
    : "delivery failed — Telegram rejected the upload";
  if (notes.length || !ids.length) {
    return failure(
      status +
        (notes.length ? `\nnot attached:\n${notes.join("\n")}` : "") +
        `\n${TG_ATTACHMENT_FAILURE_GUIDANCE}`,
      ids.length > 0,
    );
  }
  return text(status);
}

/**
 * An in-process MCP server that lets the agent post into one specific topic.
 * `cwd` is the session's working directory — what a relative attachment path
 * is relative to.
 */
export function createTgChannel(out: TopicRenderer, cwd: string): TgChannel {
  let sent = 0;

  const send = async (args: TgSendArgs): Promise<TgSendResult> => {
    const result = await runTgSend(out, cwd, args);
    if (tgSendDelivered(result)) sent++;
    return result;
  };

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
          return send(args);
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
