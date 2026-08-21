/**
 * Adopt an existing Claude Code session into the forum.
 *
 * A session started in the terminal already lives on disk; all this bot needs
 * to keep talking to it is a topic bound to its id. So `/telegramify` doesn't
 * copy or replay anything into the session — it creates the topic, writes the
 * row, and the next message you send there resumes that very session. The one
 * thing it does carry over is the agent's last reply, posted into the fresh
 * topic so the conversation doesn't restart against a blank wall.
 *
 *   npm run telegramify -- --session <uuid> [--cwd <dir>] [--title <text>]
 *
 * With no `--session`, `$CLAUDE_CODE_SESSION_ID` is used (set inside every
 * Claude Code session), and failing that the most recent session in `--cwd`.
 */
import {
  getSessionInfo,
  getSessionMessages,
  listSessions,
  type SDKSessionInfo,
  type SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { dirname, resolve } from "node:path";
import { Api } from "grammy";
import { cfg } from "./config.ts";
import { isPendingTitle, placeholderTitle } from "./cwd.ts";
import { createTopic, findBySession, setStatus } from "./db.ts";
import { brokerPid } from "./heartbeat.ts";
import { TopicRenderer } from "./render.ts";

/** How much of the carried-over reply is worth re-posting, in raw characters. */
const REPLY_LIMIT = 3000;

interface Args {
  session?: string;
  cwd?: string;
  title?: string;
  dryRun?: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]!.replace(/^--/, "");
    if (key === "dry-run") {
      out.dryRun = true;
      continue;
    }
    if (key !== "session" && key !== "cwd" && key !== "title") {
      throw new Error(`unknown argument: ${argv[i]}`);
    }
    const value = argv[++i];
    if (!value) throw new Error(`--${key} needs a value`);
    out[key] = value;
  }
  return out;
}

/** The session to adopt: the one asked for, or the newest one in `cwd`. */
async function resolveSession(args: Args): Promise<SDKSessionInfo> {
  const cwd = args.cwd ?? process.cwd();
  const id = args.session ?? process.env.CLAUDE_CODE_SESSION_ID;

  if (id) {
    // `dir` is a hint only — without it every project directory is searched,
    // which is what we want when the session was started somewhere else.
    const info = (await getSessionInfo(id, { dir: cwd })) ?? (await getSessionInfo(id));
    if (!info) throw new Error(`no session ${id} on disk (looked in ${cwd} and all projects)`);
    return info;
  }

  const [newest] = await listSessions({ dir: cwd, limit: 1, includeProgrammatic: false });
  if (!newest) throw new Error(`no Claude sessions found for ${cwd}`);
  return newest;
}

/**
 * The directory a resume will actually find the session from.
 *
 * A transcript is filed under the project directory of the cwd the session was
 * *started* in, and stays there for good. `cd` into a subdirectory during the
 * session and `$PWD` — what `/telegramify` passes as `--cwd` — names a project
 * that holds no such session, so every turn in the adopted topic dies on
 * "No conversation found with session ID". Bind the topic to a directory the
 * session can be found from instead: the one it was started in, or failing that
 * the nearest ancestor that resolves.
 */
async function resumableCwd(id: string, wanted: string, launched?: string): Promise<string> {
  const holds = async (dir: string) => Boolean(await getSessionInfo(id, { dir }));
  if (await holds(wanted)) return wanted;
  if (launched && launched !== wanted && (await holds(launched))) return launched;
  for (let dir = wanted; dir !== dirname(dir); ) {
    dir = dirname(dir);
    if (await holds(dir)) return dir;
  }
  return wanted;
}

type Block = { type?: string; text?: string };

/** The content blocks of a transcript message, normalised to an array. */
function blocksOf(msg: SessionMessage): Block[] {
  const content = (msg.message as { content?: unknown } | null)?.content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? (content as Block[]) : [];
}

/** Plain text of a message's blocks; thinking and tool calls contribute nothing. */
function textOf(blocks: Block[]): string {
  return blocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text!.trim())
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Whether a `user` message is really the slash command that got us here rather
 * than something the user said. `/telegramify` writes its own invocation — and
 * this CLI's output — into the transcript, so both have to stay transparent to
 * a search that runs while they're being written.
 */
function isCommandEcho(msg: SessionMessage): boolean {
  const text = textOf(blocksOf(msg));
  return /<command-(name|message|args)>|<local-command-stdout>|^\[telegramify\]/m.test(text);
}

/** Cut an over-long reply at a line break, leaving no code fence hanging open. */
function clip(text: string): string {
  if (text.length <= REPLY_LIMIT) return text;
  const cut = text.slice(0, REPLY_LIMIT);
  const nl = cut.lastIndexOf("\n");
  let out = (nl > REPLY_LIMIT / 2 ? cut.slice(0, nl) : cut).trimEnd();
  if ((out.match(/^\s*```/gm) ?? []).length % 2 === 1) out += "\n```";
  return `${out}\n\n… (cut — the full reply is still in the session)`;
}

/**
 * What the agent said last in the terminal, ready to post — its answer, not the
 * running commentary it typed between tool calls.
 *
 * The transcript files text and tool calls as separate entries, so an answer is
 * whatever text sits at the very end of the turn: walk back from the tail,
 * collecting text until the first tool call, prompt or tool result. Anything
 * earlier is a step, and a turn cut short mid-tool has no answer to carry at
 * all. Only the current turn is searched — reaching back further would surface
 * a reply to a question nobody in the new topic can see, which reads like
 * context but isn't.
 */
async function lastReply(sessionId: string, cwd: string): Promise<string | null> {
  let messages: SessionMessage[];
  try {
    messages = await getSessionMessages(sessionId, { dir: cwd });
  } catch (err) {
    console.warn(`[telegramify] couldn't read the transcript:`, String(err));
    return null;
  }

  const parts: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.type === "user") {
      if (isCommandEcho(msg)) continue;
      break; // a prompt, or a tool result: the turn's text ends here
    }
    if (msg.type !== "assistant" || msg.parent_tool_use_id !== null) continue;
    const blocks = blocksOf(msg);
    if (blocks.some((b) => b.type === "tool_use")) break;
    const text = textOf(blocks);
    if (text) parts.unshift(text);
  }

  const reply = parts.join("\n\n");
  return reply ? clip(reply) : null;
}

/** Prefer a name the user or Claude chose; fall back to the pending placeholder. */
function titleFor(info: SDKSessionInfo, override?: string): string {
  if (override) return override.slice(0, 128);
  const named = info.customTitle?.trim() || info.summary?.trim();
  // Until Claude names a session, `summary` is just the first prompt echoed
  // back — mark that as provisional so the bot retitles the topic later.
  if (named && named !== info.firstPrompt?.trim()) return named.slice(0, 128);
  return placeholderTitle(named || info.firstPrompt || "session");
}

/** Deep link to a topic in a supergroup: -100<internal> -> t.me/c/<internal>. */
function topicLink(threadId: number): string {
  const internal = String(cfg.chatId).replace(/^-100/, "");
  return `https://t.me/c/${internal}/${threadId}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // A topic is only worth creating if something is polling for it. Without the
  // broker the session would look adopted and answer nothing.
  if (brokerPid() === null) {
    throw new Error(
      "the claude-tg-forum broker isn't running — start it with `npm start` " +
        `in ${process.cwd()} and try again`,
    );
  }

  const info = await resolveSession(args);
  const wanted = resolve(args.cwd ?? info.cwd ?? process.cwd());
  const cwd = await resumableCwd(info.sessionId, wanted, info.cwd && resolve(info.cwd));
  if (cwd !== wanted) {
    console.warn(`[telegramify] ${wanted} holds no session ${info.sessionId} — binding to ${cwd}`);
  }
  const api = new Api(cfg.token);

  // Already adopted: hand back the topic that owns it rather than forking the
  // session across two threads.
  const existing = findBySession(info.sessionId);
  if (existing) {
    if (existing.status === "closed") {
      try {
        await api.reopenForumTopic(cfg.chatId, existing.thread_id);
      } catch (err) {
        console.warn(`[telegramify] reopening ${existing.thread_id} failed:`, String(err));
      }
      setStatus(existing.thread_id, "active");
    }
    console.log(`Already in Telegram: «${existing.title}»\n${topicLink(existing.thread_id)}`);
    return;
  }

  const title = titleFor(info, args.title);
  const carried = await lastReply(info.sessionId, cwd);
  if (args.dryRun) {
    console.log(
      `Would create «${title}»\nsession: ${info.sessionId}\ncwd: ${cwd}\n` +
        `last reply: ${carried ? `${carried.length} chars — ${carried.split("\n")[0]}` : "none to carry"}`,
    );
    return;
  }

  const topic = await api.createForumTopic(cfg.chatId, title);
  const threadId = topic.message_thread_id;
  createTopic({ threadId, cwd, title, sessionId: info.sessionId });

  const intro =
    `📲 Session adopted from the terminal.\n\n` +
    `cwd: ${cwd}\n` +
    `session: ${info.sessionId}\n\n` +
    `Write here to continue it. Keep talking to the same session in the ` +
    `terminal as well and the two will fight over the transcript — pick one.`;
  try {
    await api.sendMessage(cfg.chatId, intro, { message_thread_id: threadId });
  } catch (err) {
    console.warn(`[telegramify] intro message failed:`, String(err));
  }

  // The session remembers everything; the topic starts blank. Re-posting the
  // agent's last reply is what makes the handover readable — it's a copy for
  // the reader, not an import: nothing here is fed back into the session.
  if (carried) {
    const out = new TopicRenderer(api, cfg.chatId, threadId);
    await out.sendText(`↩️ Where the terminal left off:\n\n${carried}`);
  }


  console.log(
    `Moved to Telegram: «${isPendingTitle(title) ? title.slice(2) : title}»\n${topicLink(threadId)}`,
  );
}

main().catch((err) => {
  console.error(`[telegramify] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
