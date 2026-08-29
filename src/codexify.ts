/** Adopt an existing Codex terminal session into a Telegram topic. */
import { resolve } from "node:path";
import { Api } from "grammy";
import { codexRequest } from "./codex-app-server.ts";
import { cfg } from "./config.ts";
import { isPendingTitle, placeholderTitle } from "./cwd.ts";
import { createTopic, findBySession, setStatus } from "./db.ts";
import { brokerPid } from "./heartbeat.ts";
import { TopicRenderer } from "./render.ts";

const REPLY_LIMIT = 3000;

interface Args {
  session?: string;
  cwd?: string;
  title?: string;
  dryRun?: boolean;
}

interface CodexItem {
  type: string;
  text?: string;
  phase?: string | null;
}

interface CodexTurn {
  status: string;
  items: CodexItem[];
}

interface CodexThread {
  id: string;
  cwd: string;
  name?: string | null;
  preview: string;
  turns: CodexTurn[];
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

async function readThread(id: string): Promise<CodexThread> {
  const result = await codexRequest<{ thread: CodexThread }>("thread/read", {
    threadId: id,
    includeTurns: true,
  });
  return result.thread;
}

async function resolveThread(args: Args): Promise<CodexThread> {
  const id = args.session ?? process.env.CODEX_THREAD_ID ?? process.env.CODEX_SESSION_ID;
  if (id) return readThread(id);

  const cwd = resolve(args.cwd ?? process.cwd());
  const result = await codexRequest<{ data: CodexThread[] }>("thread/list", {
    cwd,
    limit: 1,
    sortKey: "recency_at",
    sortDirection: "desc",
    sourceKinds: ["cli"],
  });
  const thread = result.data[0];
  if (!thread) throw new Error(`no Codex sessions found for ${cwd}`);
  return readThread(thread.id);
}

function clip(text: string): string {
  if (text.length <= REPLY_LIMIT) return text;
  const cut = text.slice(0, REPLY_LIMIT);
  const newline = cut.lastIndexOf("\n");
  let out = (newline > REPLY_LIMIT / 2 ? cut.slice(0, newline) : cut).trimEnd();
  if ((out.match(/^\s*```/gm) ?? []).length % 2 === 1) out += "\n```";
  return `${out}\n\n… (cut — the full reply is still in the session)`;
}

/** The completed final answer of the newest completed turn, if it had one. */
function lastReply(thread: CodexThread): string | null {
  const turn = thread.turns.findLast((candidate) => candidate.status === "completed");
  if (!turn) return null;
  const final = turn.items.findLast(
    (item) =>
      item.type === "agentMessage" &&
      item.phase === "final_answer" &&
      Boolean(item.text?.trim()),
  );
  const text = final?.text?.trim();
  return text ? clip(text) : null;
}

function titleFor(thread: CodexThread, override?: string): string {
  if (override) return override.slice(0, 128);
  const name = thread.name?.trim();
  return name ? name.slice(0, 128) : placeholderTitle(thread.preview || "Codex session");
}

function topicLink(threadId: number): string {
  const internal = String(cfg.chatId).replace(/^-100/, "");
  return `https://t.me/c/${internal}/${threadId}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (brokerPid() === null) {
    throw new Error(
      "the ai-telegram-forum broker isn't running — start it with `npm start` " +
        `in ${process.cwd()} and try again`,
    );
  }

  const thread = await resolveThread(args);
  const cwd = resolve(args.cwd ?? thread.cwd);
  const existing = findBySession(thread.id, "codex");
  const api = new Api(cfg.token);
  if (existing) {
    if (existing.status === "closed") {
      await api
        .reopenForumTopic(cfg.chatId, existing.thread_id)
        .catch((err) => console.warn(`[codexify] reopening ${existing.thread_id} failed:`, String(err)));
      setStatus(existing.thread_id, "active");
    }
    console.log(`Already in Telegram: «${existing.title}»\n${topicLink(existing.thread_id)}`);
    return;
  }

  const title = titleFor(thread, args.title);
  const carried = lastReply(thread);
  if (args.dryRun) {
    console.log(
      `Would create «${title}»\nsession: ${thread.id}\ncwd: ${cwd}\n` +
        `last reply: ${carried ? `${carried.length} chars — ${carried.split("\n")[0]}` : "none to carry"}`,
    );
    return;
  }

  const topic = await api.createForumTopic(cfg.chatId, title);
  const threadId = topic.message_thread_id;
  createTopic({
    threadId,
    cwd,
    title,
    provider: "codex",
    sessionId: thread.id,
  });

  const intro =
    `📲 Codex session adopted from the terminal.\n\n` +
    `cwd: ${cwd}\n` +
    `session: ${thread.id}\n\n` +
    `Write here to continue it. Keep talking to the same session in the terminal ` +
    `as well and the two will fight over the transcript — pick one.`;
  await api
    .sendMessage(cfg.chatId, intro, { message_thread_id: threadId })
    .catch((err) => console.warn("[codexify] intro message failed:", String(err)));

  if (carried) {
    await new TopicRenderer(api, cfg.chatId, threadId).sendText(
      `↩️ Where the terminal left off:\n\n${carried}`,
    );
  }

  console.log(
    `Moved to Telegram: «${isPendingTitle(title) ? title.slice(2) : title}»\n` +
      topicLink(threadId),
  );
}

main().catch((err) => {
  console.error(`[codexify] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
