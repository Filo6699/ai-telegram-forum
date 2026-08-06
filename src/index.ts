import { Bot } from "grammy";
import { cfg } from "./config.ts";
import { placeholderTitle, resolveCwd } from "./cwd.ts";
import { fmtTokens, humanUntil } from "./fmt.ts";
import { fetchPlanLimits, type PlanLimits } from "./limits.ts";
import { registerPermissionButtons } from "./permission.ts";
import { sessionFor } from "./session.ts";
import { startSweep } from "./sweep.ts";
import { createTopic, getTopic, setStatus, totals, type Topic } from "./db.ts";

const bot = new Bot(cfg.token);

const isLauncher = (threadId: number | undefined) =>
  threadId === undefined || threadId === cfg.launcherThreadId;

const fmt = fmtTokens;

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

/** The plan's own limits — what the CLI's `/usage` shows, not this bot's tally. */
function planText(limits: PlanLimits | null): string {
  if (!limits) return "_plan limits unavailable (API key or 3rd-party provider)_";
  if (!limits.windows.length) return "_no plan limit windows reported_";
  const plan = limits.subscription ? ` (${limits.subscription})` : "";
  const lines = limits.windows.map((w) => {
    const used = w.utilization === null ? "?" : `${Math.round(w.utilization)}%`;
    const reset = w.resetsAt ? ` · resets in ${humanUntil(w.resetsAt)}` : "";
    return `${w.label}: ${used}${reset}`;
  });
  return [`⏳ *Claude plan${plan}*`, ...lines].join("\n");
}

async function handleCommand(ctx: any, thread: number | undefined): Promise<boolean> {
  const cmd = ctx.message.text.trim().split(/\s+/)[0].toLowerCase();
  if (cmd !== "/usage" && cmd !== `/usage@${botUsername}`) return false;

  // In a task topic -> that topic's usage; in the launcher -> grand total.
  const t = thread !== undefined ? getTopic(thread) : undefined;
  const local = t ? topicUsageText(t) : totalsText();

  // Asking claude.ai for the plan limits can take a few seconds (and may have
  // to start a child), so post the local tally first and fill the rest in.
  const sent = await ctx.reply(`${local}\n\n⏳ _checking plan limits…_`, {
    message_thread_id: thread,
    parse_mode: "Markdown",
  });

  let plan: string;
  try {
    plan = planText(await fetchPlanLimits());
  } catch (err) {
    console.warn("[usage] plan limits failed:", String(err));
    plan = "_plan limits unavailable_";
  }
  try {
    await ctx.api.editMessageText(ctx.chat.id, sent.message_id, `${local}\n\n${plan}`, {
      parse_mode: "Markdown",
    });
  } catch (err) {
    console.warn("[usage] editing the reply failed:", String(err));
  }
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

  // Receipt ack. A message sent mid-turn won't be answered until the agent
  // reaches its next step, so say "seen" right away.
  void ctx.react("👀").catch(() => {});

  // ---- A) Launcher: spin up a new topic + session -----------------------
  if (isLauncher(thread)) {
    const { cwd, prompt } = resolveCwd(text);
    const title = placeholderTitle(prompt);

    const topic = await ctx.api.createForumTopic(cfg.chatId, title);
    const tid = topic.message_thread_id;
    createTopic({ threadId: tid, cwd, title });

    await ctx.reply(`→ «${title}»  (cwd: ${cwd})`, {
      message_thread_id: cfg.launcherThreadId,
    });

    // The launcher message lives in another topic — repeat it here so the
    // thread reads as a whole conversation.
    try {
      await ctx.api.sendMessage(cfg.chatId, prompt, { message_thread_id: tid });
    } catch (err) {
      console.warn(`[launch] echoing the prompt into ${tid} failed:`, String(err));
    }

    await sessionFor(bot, { thread_id: tid, cwd, session_id: null }).send(prompt);
    return;
  }

  // ---- B) Existing task topic: resume its session -----------------------
  if (thread === undefined) return; // handled by launcher branch above
  const t = getTopic(thread);
  if (!t) return; // not a topic we manage

  if (t.status === "closed") {
    try {
      await bot.api.reopenForumTopic(cfg.chatId, thread);
    } catch (err) {
      console.warn(`[reopen] failed for ${thread}:`, String(err));
    }
    setStatus(thread, "active");
  }

  // The session takes it from here: if a turn is already running, this lands
  // in front of the agent at its next step rather than waiting in a queue.
  await sessionFor(bot, t).send(text);
});

bot.catch((err) => {
  console.error("[bot] unhandled error:", err.error);
});

async function main() {
  const me = await bot.api.getMe();
  botUsername = me.username;
  console.log(`[bot] running as @${me.username}`);
  console.log(
    `[bot] forum chat ${cfg.chatId}, launcher thread ${cfg.launcherThreadId ?? "General"}`,
  );
  console.log(`[bot] permission=${cfg.permission} model=${cfg.model}`);

  await bot.api.setMyCommands([
    { command: "usage", description: "Tokens/cost here (or all in the launcher) + plan limits" },
  ]);

  registerPermissionButtons(bot);
  startSweep(bot);
  await bot.start({ allowed_updates: ["message", "callback_query"] });
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
