import { Bot } from "grammy";
import { cfg } from "./config.ts";
import { runTurn } from "./claude.ts";
import { resolveCwd, titleFrom } from "./cwd.ts";
import { startSweep } from "./sweep.ts";
import {
  addUsage,
  createTopic,
  getTopic,
  setSession,
  setStatus,
  totals,
  touch,
  type Topic,
} from "./db.ts";

const bot = new Bot(cfg.token);

// Per-topic serialization: never run two turns in the same topic at once.
const locks = new Map<number, Promise<unknown>>();
function withLock<T>(threadId: number, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(threadId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(
    threadId,
    next.finally(() => {
      if (locks.get(threadId) === next) locks.delete(threadId);
    }),
  );
  return next;
}

const isLauncher = (threadId: number | undefined) =>
  threadId === undefined || threadId === cfg.launcherThreadId;

const fmt = (n: number) =>
  n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

function topicUsageText(t: Topic): string {
  return (
    `📊 *${t.title}*\n` +
    `turns: ${t.turns}\n` +
    `tokens: ${fmt(t.in_tokens)} in / ${fmt(t.out_tokens)} out\n` +
    `cost: $${t.cost_usd.toFixed(4)}`
  );
}

function totalsText(): string {
  const s = totals();
  return (
    `📊 *All topics*\n` +
    `topics: ${s.topics} · turns: ${s.turns}\n` +
    `tokens: ${fmt(s.in_tokens)} in / ${fmt(s.out_tokens)} out\n` +
    `cost: $${s.cost_usd.toFixed(4)}`
  );
}

async function handleCommand(ctx: any, thread: number | undefined): Promise<boolean> {
  const cmd = ctx.message.text.trim().split(/\s+/)[0].toLowerCase();
  if (cmd !== "/usage" && cmd !== `/usage@${botUsername}`) return false;

  // In a task topic -> that topic's usage; in the launcher -> grand total.
  const t = thread !== undefined ? getTopic(thread) : undefined;
  const text = t ? topicUsageText(t) : totalsText();
  await ctx.reply(text, {
    message_thread_id: thread,
    parse_mode: "Markdown",
  });
  return true;
}

let botUsername = "";

bot.on("message:text", async (ctx) => {
  // Single-user gate: silently ignore anyone else.
  if (ctx.from?.id !== cfg.allowedUserId) return;
  // Ignore messages outside the configured forum.
  if (ctx.chat.id !== cfg.chatId) return;
  const thread = ctx.message.message_thread_id;
  const text = ctx.message.text;

  // Commands (e.g. /usage) are handled here; other /… messages are ignored.
  if (text.startsWith("/")) {
    await handleCommand(ctx, thread);
    return;
  }

  // ---- A) Launcher: spin up a new topic + session -----------------------
  if (isLauncher(thread)) {
    const { cwd, prompt } = resolveCwd(text);
    const title = titleFrom(prompt);

    const topic = await ctx.api.createForumTopic(cfg.chatId, title);
    const tid = topic.message_thread_id;
    createTopic({ threadId: tid, cwd, title });

    await ctx.reply(`→ «${title}»  (cwd: ${cwd})`, {
      message_thread_id: cfg.launcherThreadId,
    });

    await withLock(tid, async () => {
      const { sessionId, usage } = await runTurn(bot, tid, cwd, prompt);
      if (sessionId) setSession(tid, sessionId);
      else touch(tid);
      addUsage(tid, usage);
    });
    return;
  }

  // ---- B) Existing task topic: resume its session -----------------------
  if (thread === undefined) return; // handled by launcher branch above
  const t = getTopic(thread);
  if (!t) return; // not a topic we manage

  await withLock(thread, async () => {
    if (t.status === "closed") {
      try {
        await bot.api.reopenForumTopic(cfg.chatId, thread);
      } catch (err) {
        console.warn(`[reopen] failed for ${thread}:`, String(err));
      }
      setStatus(thread, "active");
    }
    touch(thread);
    const { sessionId, usage } = await runTurn(bot, thread, t.cwd, text, t.session_id);
    if (sessionId) setSession(thread, sessionId);
    addUsage(thread, usage);
  });
});

bot.catch((err) => {
  console.error("[bot] unhandled error:", err.error);
});

async function main() {
  const me = await bot.api.getMe();
  botUsername = me.username;
  console.log(`[bot] running as @${me.username}`);
  console.log(`[bot] forum chat ${cfg.chatId}, launcher thread ${cfg.launcherThreadId}`);
  console.log(`[bot] permission=${cfg.permission} model=${cfg.model}`);

  await bot.api.setMyCommands([
    { command: "usage", description: "Token/cost usage (this topic, or all in the launcher)" },
  ]);

  startSweep(bot);
  await bot.start({ allowed_updates: ["message"] });
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
