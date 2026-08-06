/**
 * Adopt an existing Claude Code session into the forum.
 *
 * A session started in the terminal already lives on disk; all this bot needs
 * to keep talking to it is a topic bound to its id. So `/telegramify` doesn't
 * copy or replay anything — it creates the topic, writes the row, and the next
 * message you send there resumes that very session.
 *
 *   npm run telegramify -- --session <uuid> [--cwd <dir>] [--title <text>]
 *
 * With no `--session`, `$CLAUDE_CODE_SESSION_ID` is used (set inside every
 * Claude Code session), and failing that the most recent session in `--cwd`.
 */
import { getSessionInfo, listSessions, type SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import { Api } from "grammy";
import { cfg } from "./config.ts";
import { isPendingTitle, placeholderTitle } from "./cwd.ts";
import { createTopic, findBySession, setStatus } from "./db.ts";

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
  const info = await resolveSession(args);
  const cwd = args.cwd ?? info.cwd ?? process.cwd();
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
  if (args.dryRun) {
    console.log(`Would create «${title}»\nsession: ${info.sessionId}\ncwd: ${cwd}`);
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

  console.log(
    `Moved to Telegram: «${isPendingTitle(title) ? title.slice(2) : title}»\n${topicLink(threadId)}`,
  );
}

main().catch((err) => {
  console.error(`[telegramify] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
