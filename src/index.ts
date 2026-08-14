import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { Bot } from "grammy";
import { cfg } from "./config.ts";
import { fetchImage, isSupportedImage, type ImagePart } from "./media.ts";
import { placeholderTitle, resolveCwd } from "./cwd.ts";
import {
  askEffort,
  defaultEffort,
  effortLabel,
  effortUsage,
  LAUNCH_WAIT_MS,
  parseEffort,
  registerEffortButtons,
  type Effort,
} from "./effort.ts";
import { fmtTokens } from "./fmt.ts";
import { startHeartbeat } from "./heartbeat.ts";
import { fetchPlanLimits, planLimitsText } from "./limits.ts";
import { registerPermissionButtons } from "./permission.ts";
import { liveSession, sessionFor } from "./session.ts";
import { startSweep } from "./sweep.ts";
import { createTopic, getTopic, setEffort, setStatus, totals, type Topic } from "./db.ts";

const bot = new Bot(cfg.token);

const isLauncher = (threadId: number | undefined) =>
  threadId === undefined || threadId === cfg.launcherThreadId;

const fmt = fmtTokens;

function topicUsageText(t: Topic): string {
  return (
    `📊 *${t.title}*\n` +
    `turns: ${t.turns}\n` +
    `effort: ${effortLabel(t.effort, defaultEffort(t.cwd))}\n` +
    `tokens: ${fmt(t.in_tokens)} in / ${fmt(t.out_tokens)} out\n` +
    `cost: $${t.cost_usd.toFixed(4)}`
  );
}

function totalsText(): string {
  const s = totals();
  return (
    `📊 *All topics*\n` +
    `topics: ${s.topics} · turns: ${s.turns}\n` +
    `next session effort: ${effortLabel(nextEffort ?? null, defaultEffort(cfg.defaultCwd))}\n` +
    `tokens: ${fmt(s.in_tokens)} in / ${fmt(s.out_tokens)} out\n` +
    `cost: $${s.cost_usd.toFixed(4)}`
  );
}

/**
 * `/effort` in the launcher belongs to the next session only: it is consumed by
 * the launch that follows, where it arrives as the picker's pre-selection.
 */
let nextEffort: Effort | undefined;

function takeNextEffort(): Effort {
  const e = nextEffort ?? null;
  nextEffort = undefined;
  return e;
}

/**
 * Put a chosen level into effect: the launcher holds it for the next session, a
 * topic records it against itself and hands it to the agent from the next turn.
 * `announce` is off when the choice came from a picker — its own message
 * already says what was picked.
 */
async function applyEffort(
  ctx: any,
  thread: number | undefined,
  level: Effort,
  announce = true,
): Promise<void> {
  if (isLauncher(thread)) {
    nextEffort = level;
    if (announce) {
      const label = effortLabel(level, defaultEffort(cfg.defaultCwd));
      await ctx.reply(`⚙️ next session: ${label}`, { message_thread_id: thread });
    }
    return;
  }
  const t = getTopic(thread!);
  if (!t) {
    await ctx.reply("⚠️ run this inside a session topic, not here.", {
      message_thread_id: thread,
    });
    return;
  }
  const s = liveSession(thread!);
  if (s) s.setEffort(level);
  else setEffort(thread!, level);
  if (announce) {
    await ctx.reply(`⚙️ effort: ${effortLabel(level, defaultEffort(t.cwd))}`, {
      message_thread_id: thread,
    });
  }
}

/** Shell-quote a path so the pasted command survives spaces and quotes. */
function shq(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * `/resume` and `/id` only make sense inside a task topic — the launcher has no
 * session of its own. Returns the topic, or replies with why it can't.
 */
async function sessionTopic(ctx: any, thread: number | undefined): Promise<Topic | undefined> {
  const t = thread !== undefined && !isLauncher(thread) ? getTopic(thread) : undefined;
  if (!t) {
    await ctx.reply("⚠️ run this inside a session topic, not here.", {
      message_thread_id: thread,
    });
    return;
  }
  if (!t.session_id) {
    await ctx.reply("⚠️ this topic has no session id yet — send a message first.", {
      message_thread_id: thread,
    });
    return;
  }
  return t;
}

async function handleCommand(ctx: any, thread: number | undefined): Promise<boolean> {
  const raw = ctx.message.text.trim().split(/\s+/)[0].toLowerCase();
  // `/cmd@thisbot` is the same command; anything addressed to another bot isn't.
  const at = raw.indexOf("@");
  if (at !== -1 && raw.slice(at + 1) !== botUsername.toLowerCase()) return false;
  const cmd = at === -1 ? raw : raw.slice(0, at);

  if (cmd === "/id") {
    const t = await sessionTopic(ctx, thread);
    if (t) {
      await ctx.reply(`\`${t.session_id}\``, {
        message_thread_id: thread,
        parse_mode: "Markdown",
      });
    }
    return true;
  }

  if (cmd === "/resume") {
    const t = await sessionTopic(ctx, thread);
    if (t) {
      await ctx.reply(`\`\`\`\ncd ${shq(t.cwd)} && claude --resume ${t.session_id}\n\`\`\``, {
        message_thread_id: thread,
        parse_mode: "Markdown",
      });
    }
    return true;
  }

  if (cmd === "/effort") {
    const arg = ctx.message.text.trim().split(/\s+/)[1];
    if (arg) {
      const level = parseEffort(arg);
      if (level === undefined) {
        await ctx.reply(effortUsage, { message_thread_id: thread });
        return true;
      }
      await applyEffort(ctx, thread, level);
      return true;
    }
    // No level given — same effect, chosen with the buttons instead.
    const inLauncher = isLauncher(thread);
    const topic = inLauncher ? undefined : getTopic(thread!);
    void askEffort(bot, {
      threadId: thread,
      title: inLauncher ? "effort for the next session" : "effort for this topic",
      initial: inLauncher ? (nextEffort ?? null) : (topic?.effort ?? null),
      cwd: topic?.cwd ?? cfg.defaultCwd,
    })
      .then((level) => applyEffort(ctx, thread, level, false))
      .catch((err) => console.warn("[effort] applying the picked level failed:", String(err)));
    return true;
  }

  if (cmd === "/stop") {
    const s = thread !== undefined && !isLauncher(thread) ? liveSession(thread) : undefined;
    let stopped = false;
    if (s) {
      try {
        stopped = await s.interrupt();
      } catch (err) {
        console.warn(`[stop] interrupting ${thread} failed:`, String(err));
        await ctx.reply(`⚠️ couldn't stop it: ${String(err)}`, { message_thread_id: thread });
        return true;
      }
    }
    if (!stopped) {
      await ctx.reply("⚠️ nothing running here.", { message_thread_id: thread });
    }
    return true;
  }

  if (cmd !== "/usage") return false;

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
    plan = planLimitsText(await fetchPlanLimits());
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

/** The message as the agent sees it: text alone, or images plus their caption. */
function contentOf(text: string, images: ImagePart[]): SDKUserMessage["message"]["content"] {
  if (!images.length) return text;
  const blocks: Exclude<SDKUserMessage["message"]["content"], string> = images.map((img) => ({
    type: "image",
    source: { type: "base64", media_type: img.mediaType as any, data: img.data },
  }));
  // An empty text block is rejected by the API — a caption-less photo is fine.
  if (text) blocks.push({ type: "text", text });
  return blocks;
}

/**
 * Spin up a new topic + session for a launcher message.
 *
 * Detached on purpose: grammy handles updates one at a time, and this waits on
 * the effort picker — buttons whose presses arrive as updates of their own.
 * Awaiting it inside the handler would stall the very callbacks it waits for.
 * Each launcher message gets its own picker, so two launches never queue behind
 * each other.
 */
async function launch(ctx: any, text: string, images: ImagePart[]): Promise<void> {
  const { cwd, prompt } = resolveCwd(text);
  const title = placeholderTitle(prompt || "image");

  // Nothing exists yet: the effort is chosen first, and only then is the topic
  // created. An untouched picker falls through in seconds, so a launch nobody
  // answers still starts — but once the user reaches for a button, the launch
  // waits for them to finish.
  const effort = await askEffort(bot, {
    threadId: cfg.launcherThreadId,
    title: `effort for «${title}»`,
    initial: takeNextEffort(),
    cwd,
    firstWaitMs: LAUNCH_WAIT_MS,
  });

  const topic = await ctx.api.createForumTopic(cfg.chatId, title);
  const tid = topic.message_thread_id;
  createTopic({ threadId: tid, cwd, title, effort });

  await ctx.reply(`→ «${title}»  (cwd: ${cwd})`, {
    message_thread_id: cfg.launcherThreadId,
  });

  // The launcher message lives in another topic — repeat it here so the
  // thread reads as a whole conversation. A photo is copied verbatim;
  // plain text is re-sent without its cwd prefix.
  try {
    if (images.length) {
      await ctx.api.copyMessage(cfg.chatId, cfg.chatId, ctx.message.message_id, {
        message_thread_id: tid,
      });
    } else {
      await ctx.api.sendMessage(cfg.chatId, prompt, { message_thread_id: tid });
    }
  } catch (err) {
    console.warn(`[launch] echoing the prompt into ${tid} failed:`, String(err));
  }

  await sessionFor(bot, { thread_id: tid, cwd, session_id: null, effort }).send(
    contentOf(prompt, images),
  );
}

/** Route one inbound user message (with any images already downloaded). */
async function route(ctx: any, text: string, images: ImagePart[]): Promise<void> {
  const thread: number | undefined = ctx.message.message_thread_id;

  // ---- A) Launcher: spin up a new topic + session -----------------------
  if (isLauncher(thread)) {
    void launch(ctx, text, images).catch(async (err) => {
      console.error("[launch] failed:", err);
      await ctx
        .reply(`❌ couldn't start that session: ${String(err)}`, {
          message_thread_id: cfg.launcherThreadId,
        })
        .catch(() => {});
    });
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
  await sessionFor(bot, t).send(contentOf(text, images));
}

/** Single-user gate + right-forum check, shared by every message handler. */
const mine = (ctx: any): boolean =>
  ctx.from?.id === cfg.allowedUserId && ctx.chat.id === cfg.chatId;

bot.on("message:text", async (ctx) => {
  if (!mine(ctx)) return;
  const text = ctx.message.text;

  // Commands (e.g. /usage) are handled here; other /… messages are ignored.
  if (text.startsWith("/")) {
    await handleCommand(ctx, ctx.message.message_thread_id);
    return;
  }

  await route(ctx, text, []);
});

/**
 * Photos, and documents Telegram tags as an image (what "send as file" makes).
 * An album arrives as one message per photo; each is its own turn input, which
 * the session hands to the agent together at its next step.
 */
bot.on(["message:photo", "message:document"], async (ctx) => {
  if (!mine(ctx)) return;

  const doc = ctx.message.document;
  // The last photo size is the largest one Telegram kept.
  const fileId = doc ? doc.file_id : ctx.message.photo?.at(-1)?.file_id;
  if (!fileId) return;
  if (doc && !isSupportedImage(doc.mime_type)) return; // not an image — nothing to pass on

  let image: ImagePart;
  try {
    image = await fetchImage(ctx.api, fileId, doc?.mime_type);
  } catch (err) {
    console.warn("[media] fetching the image failed:", String(err));
    await ctx
      .reply(`⚠️ couldn't fetch that image: ${String(err)}`, {
        message_thread_id: ctx.message.message_thread_id,
      })
      .catch(() => {});
    return;
  }

  await route(ctx, ctx.message.caption?.trim() ?? "", [image]);
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
    { command: "effort", description: "Reasoning effort: /effort high, or /effort for buttons" },
    { command: "stop", description: "Interrupt the turn running in this topic" },
    { command: "resume", description: "Shell command to continue this session in a terminal" },
    { command: "id", description: "Claude session id of this topic" },
  ]);

  // Effort first: it passes callbacks it doesn't own on to the permission
  // buttons, which answer everything else.
  registerEffortButtons(bot);
  registerPermissionButtons(bot);
  startSweep(bot);
  // From here on `/telegramify` will adopt sessions into this forum.
  startHeartbeat();
  await bot.start({ allowed_updates: ["message", "callback_query"] });
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
