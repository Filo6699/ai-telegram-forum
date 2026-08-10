import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { Bot } from "grammy";
import { cfg } from "./config.ts";
import { fetchImage, isSupportedImage, type ImagePart } from "./media.ts";
import { placeholderTitle, resolveCwd } from "./cwd.ts";
import { fmtTokens } from "./fmt.ts";
import { startHeartbeat } from "./heartbeat.ts";
import { fetchPlanLimits, planLimitsText } from "./limits.ts";
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

/** Route one inbound user message (with any images already downloaded). */
async function route(ctx: any, text: string, images: ImagePart[]): Promise<void> {
  const thread: number | undefined = ctx.message.message_thread_id;

  // ---- A) Launcher: spin up a new topic + session -----------------------
  if (isLauncher(thread)) {
    const { cwd, prompt } = resolveCwd(text);
    const title = placeholderTitle(prompt || "image");

    const topic = await ctx.api.createForumTopic(cfg.chatId, title);
    const tid = topic.message_thread_id;
    createTopic({ threadId: tid, cwd, title });

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

    await sessionFor(bot, { thread_id: tid, cwd, session_id: null }).send(
      contentOf(prompt, images),
    );
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
    { command: "resume", description: "Shell command to continue this session in a terminal" },
    { command: "id", description: "Claude session id of this topic" },
  ]);

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
