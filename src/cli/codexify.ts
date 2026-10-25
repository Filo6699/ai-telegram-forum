/** Continue a Codex terminal session in Telegram through a persistent native fork. */
import { resolve } from "node:path";
import { Api } from "grammy";
import { codexRequest } from "../providers/codex/app-server.ts";
import { cfg } from "../config/env.ts";
import { isPendingTitle, placeholderTitle } from "../sessions/cwd.ts";
import { createTopic, findBySession, findBySourceSession, setStatus } from "../storage/db.ts";
import { brokerPid } from "../app/heartbeat.ts";
import { TopicRenderer } from "../telegram/render.ts";

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

async function readThread(id: string, request: typeof codexRequest): Promise<CodexThread> {
  const result = await request<{ thread: CodexThread }>("thread/read", {
    threadId: id,
    includeTurns: true,
  });
  return result.thread;
}

async function resolveThread(args: Args, request: typeof codexRequest): Promise<CodexThread> {
  const id = args.session ?? process.env.CODEX_THREAD_ID ?? process.env.CODEX_SESSION_ID;
  if (id) return readThread(id, request);

  const cwd = resolve(args.cwd ?? process.cwd());
  const result = await request<{ data: CodexThread[] }>("thread/list", {
    cwd,
    limit: 1,
    sortKey: "recency_at",
    sortDirection: "desc",
    sourceKinds: ["cli"],
  });
  const thread = result.data[0];
  if (!thread) throw new Error(`no Codex sessions found for ${cwd}`);
  return readThread(thread.id, request);
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

interface CodexAdoptionDependencies {
  request: typeof codexRequest;
  api: Pick<Api, "createForumTopic" | "reopenForumTopic" | "deleteForumTopic" | "sendMessage">;
  brokerPid: typeof brokerPid;
}

export async function adoptCodex(argv: string[], deps: CodexAdoptionDependencies = {
  request: codexRequest, api: new Api(cfg.token), brokerPid,
}): Promise<void> {
  const args = parseArgs(argv);
  if (deps.brokerPid() === null) {
    throw new Error(
      "the ai-telegram-forum broker isn't running — start it with `npm start` " +
        `in ${process.cwd()} and try again`,
    );
  }

  const thread = await resolveThread(args, deps.request);
  const cwd = resolve(args.cwd ?? thread.cwd);
  const bound = findBySession(thread.id, "codex");
  // Legacy direct adoptions must get a new fork too; their live topic may still
  // be using the original, so never rewrite its binding under a running agent.
  const existing = findBySourceSession(thread.id, "codex") ?? (bound?.source_session_id ? bound : undefined);
  const api = deps.api;
  if (existing) {
    if (!args.dryRun && existing.status === "closed") {
      await api
        .reopenForumTopic(cfg.chatId, existing.thread_id)
        .catch((err) => { throw new Error(`couldn't reopen Telegram fork topic: ${String(err)}`); });
      setStatus(existing.thread_id, "active");
    }
    console.log(`${args.dryRun ? "Would reuse" : "Already in"} Telegram (fork): «${existing.title}»\n` +
      `source session: ${existing.source_session_id}\nfork session: ${existing.session_id}\n` + topicLink(existing.thread_id));
    return;
  }

  const title = titleFor(thread, args.title);
  const carried = lastReply(thread);
  if (args.dryRun) {
    console.log(
      `Would create a persistent Codex fork in Telegram: «${title}»\nsource session: ${thread.id}\ncwd: ${cwd}\n` +
        `last reply: ${carried ? `${carried.length} chars — ${carried.split("\n")[0]}` : "none to carry"}`,
    );
    return;
  }

  // Native fork reads the stored history without resuming the source or taking
  // its writer lock. The terminal and its daemon can keep the original open.
  const fork = await deps.request<{ thread: { id: string } }>("thread/fork", {
    threadId: thread.id,
    cwd,
    ephemeral: false,
    excludeTurns: true,
  });
  if (!fork.thread.id || fork.thread.id === thread.id) {
    throw new Error("Codex did not return a new persistent fork; no Telegram topic was created");
  }
  // Confirm the fork survived its creating server before publishing a topic.
  await readThread(fork.thread.id, deps.request);
  const topic = await api.createForumTopic(cfg.chatId, title);
  const threadId = topic.message_thread_id;
  try {
    createTopic({
      threadId, cwd, title, provider: "codex",
      sessionId: fork.thread.id,
      sourceSessionId: thread.id,
    });
  } catch (err) {
    // A concurrent invocation may have finished first. Remove only our unused
    // Telegram topic; native forks and the source transcript are never deleted.
    await api.deleteForumTopic(cfg.chatId, threadId)
      .catch((cleanupErr) => console.warn("[telegramify] unused topic cleanup failed:", String(cleanupErr)));
    const winner = findBySourceSession(thread.id, "codex");
    if (!winner) throw err;
    console.log(`Already in Telegram (fork): «${winner.title}»\n` +
      `source session: ${thread.id}\nfork session: ${winner.session_id}\n${topicLink(winner.thread_id)}`);
    return;
  }

  const intro =
    `📲 This is a persistent Codex fork of the terminal session.\n\n` +
    `cwd: ${cwd}\n` +
    `source session: ${thread.id}\n` +
    `fork session: ${fork.thread.id}\n\n` +
    `Write here to continue from the saved history at the time of the fork. ` +
    `The original session remains in the terminal; later messages are independent. ` +
    `An unfinished terminal turn may be only partially included. ` +
    `Both sessions use the same project files; avoid simultaneous edits.`;
  await api
    .sendMessage(cfg.chatId, intro, { message_thread_id: threadId })
    .catch((err) => console.warn("[telegramify] intro message failed:", String(err)));

  if (carried) {
    await new TopicRenderer(api as Api, cfg.chatId, threadId).sendText(
      `↩️ Where the terminal left off:\n\n${carried}`,
    );
  }

  console.log(
    `Created a persistent Codex fork in Telegram: «${isPendingTitle(title) ? title.slice(2) : title}»\n` +
      `source session: ${thread.id}\nfork session: ${fork.thread.id}\n` +
      topicLink(threadId),
  );
}
