import { Bot, InlineKeyboard } from "grammy";
import { cfg } from "./config.ts";
import { fetchCodexPlanLimits } from "./codex-limits.ts";
import {
  classify,
  fetchDocument,
  fetchImage,
  humanSize,
  isService,
  type DocumentPart,
  type ImagePart,
} from "./media.ts";
import { placeholderTitle, resolveCwd } from "./cwd.ts";
import {
  asEffort,
  defaultEffort,
  effortGroup,
  effortLabel,
  effortUsage,
  parseEffort,
  type Effort,
} from "./effort.ts";
import {
  asModel,
  defaultModel,
  modelGroup,
  modelLabel,
  modelUsage,
  parseModel,
  type Model,
} from "./model.ts";
import { askPick, LAUNCH_WAIT_MS, registerPickerButtons } from "./picker.ts";
import { fmtTokens } from "./fmt.ts";
import { startHeartbeat } from "./heartbeat.ts";
import { fetchPlanLimits, planLimitsText } from "./limits.ts";
import { MediaGroupCollector } from "./media-group.ts";
import { registerPermissionButtons } from "./permission.ts";
import { liveSession, sessionFor, type AgentInput } from "./session.ts";
import {
  asProvider,
  parseProvider,
  providerGroup,
  providerLabel,
  type Provider,
} from "./provider.ts";
import { startSweep } from "./sweep.ts";
import {
  createTopic,
  getTopic,
  setEffort,
  setModel,
  setStatus,
  totals,
  type Topic,
} from "./db.ts";

const bot = new Bot(cfg.token);

const isLauncher = (threadId: number | undefined) =>
  threadId === undefined || threadId === cfg.launcherThreadId;

const fmt = fmtTokens;

function topicUsageText(t: Topic): string {
  return (
    `📊 *${t.title}*\n` +
    `turns: ${t.turns}\n` +
    `agent: ${providerLabel(t.provider)}\n` +
    `model: ${modelLabel(t.model, defaultModel(t.provider), t.provider)}\n` +
    `effort: ${effortLabel(t.effort, defaultEffort(t.cwd, t.provider))}\n` +
    `tokens: ${fmt(t.in_tokens)} in / ${fmt(t.out_tokens)} out\n` +
    `cost: $${t.cost_usd.toFixed(4)}`
  );
}

function totalsText(): string {
  const s = totals();
  const provider = nextProvider ?? cfg.provider;
  return (
    `📊 *All topics*\n` +
    `topics: ${s.topics} · turns: ${s.turns}\n` +
    `next session agent: ${providerLabel(provider)}\n` +
    `next session model: ${modelLabel(nextModel ?? null, defaultModel(provider), provider)}\n` +
    `next session effort: ${effortLabel(nextEffort ?? null, defaultEffort(cfg.defaultCwd, provider))}\n` +
    `tokens: ${fmt(s.in_tokens)} in / ${fmt(s.out_tokens)} out\n` +
    `cost: $${s.cost_usd.toFixed(4)}`
  );
}

/**
 * `/effort` and `/model` in the launcher belong to the next session only: they
 * are consumed by the launch that follows, where they arrive as the picker's
 * pre-selection.
 */
let nextEffort: Effort | undefined;
let nextModel: Model | undefined;
let nextProvider: Provider | undefined;

/**
 * Where a `/effort` or `/model` lands. `null` is the launcher — the choice is
 * held for the next session; `undefined` means there is nowhere to put it, and
 * the caller has already said so.
 */
async function target(ctx: any, thread: number | undefined): Promise<Topic | null | undefined> {
  if (isLauncher(thread)) return null;
  const t = getTopic(thread!);
  if (t) return t;
  await ctx.reply("⚠️ run this inside a session topic, not here.", { message_thread_id: thread });
  return undefined;
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
  const t = await target(ctx, thread);
  if (t === undefined) return;
  if (t === null) {
    const provider = nextProvider ?? cfg.provider;
    nextEffort = level;
    if (announce) {
      const label = effortLabel(level, defaultEffort(cfg.defaultCwd, provider));
      await ctx.reply(`⚙️ next session: ${label}`, { message_thread_id: thread });
    }
    return;
  }
  const s = liveSession(t.thread_id);
  if (s) s.setEffort(level);
  else setEffort(t.thread_id, level);
  if (announce) {
    await ctx.reply(`⚙️ effort: ${effortLabel(level, defaultEffort(t.cwd, t.provider))}`, {
      message_thread_id: thread,
    });
  }
}

/** The same, for the model — a live session swaps it on the child in place. */
async function applyModel(
  ctx: any,
  thread: number | undefined,
  model: Model,
  announce = true,
): Promise<void> {
  const t = await target(ctx, thread);
  if (t === undefined) return;
  if (t === null) {
    const provider = nextProvider ?? cfg.provider;
    nextModel = model;
    if (announce) {
      await ctx.reply(
        `🤖 next session: ${modelLabel(model, defaultModel(provider), provider)}`,
        {
        message_thread_id: thread,
        },
      );
    }
    return;
  }
  const s = liveSession(t.thread_id);
  if (s) s.setModel(model);
  else setModel(t.thread_id, model);
  if (announce) {
    await ctx.reply(`🤖 model: ${modelLabel(model, defaultModel(t.provider), t.provider)}`, {
      message_thread_id: thread,
    });
  }
}

/** Provider is chosen before a topic exists; changing it would switch session
 * stores and cannot preserve history, so established topics keep theirs. */
async function applyProvider(
  ctx: any,
  thread: number | undefined,
  provider: Provider,
  announce = true,
): Promise<void> {
  if (!isLauncher(thread)) {
    await ctx.reply("⚠️ an existing topic can't change agent — choose it in the launcher.", {
      message_thread_id: thread,
    });
    return;
  }
  nextProvider = provider;
  nextModel = undefined;
  nextEffort = undefined;
  if (announce) {
    await ctx.reply(`🧠 next session agent: ${providerLabel(provider)}`, {
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

/**
 * Run a leading `/command`, and say whether it was one of ours.
 *
 * `false` means "not mine, route it as a prompt" — a launcher message may start
 * with a `/path` cwd prefix, and swallowing those is how a session goes silent.
 */
async function handleCommand(ctx: any, thread: number | undefined): Promise<boolean> {
  const raw = ctx.message.text.trim().split(/\s+/)[0];
  // A bot command is one word: `/name`, optionally `@addressed` to a bot. A
  // path prefix (`/srv/app …`) has slashes inside it, so it never matches.
  const parts = raw.match(/^\/([a-z0-9_]+)(?:@([a-z0-9_]+))?$/i);
  if (!parts) return false;
  const [, name, addressee] = parts as unknown as [string, string, string | undefined];
  // `/cmd@thisbot` is the same command; anything addressed to another bot isn't
  // ours to answer, but it isn't a prompt either — drop it.
  if (addressee && addressee.toLowerCase() !== botUsername.toLowerCase()) return true;
  const cmd = `/${name.toLowerCase()}`;

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
      const resume =
        t.provider === "codex"
          ? `codex resume ${t.session_id}`
          : `claude --resume ${t.session_id}`;
      await ctx.reply(`\`\`\`\ncd ${shq(t.cwd)} && ${resume}\n\`\`\``, {
        message_thread_id: thread,
        parse_mode: "Markdown",
      });
    }
    return true;
  }

  if (cmd === "/provider" || cmd === "/agent") {
    const arg = ctx.message.text.trim().split(/\s+/)[1];
    if (arg) {
      const provider = parseProvider(arg);
      if (!provider) {
        await ctx.reply("⚠️ unknown agent. Use `claude` or `codex`.", {
          message_thread_id: thread,
          parse_mode: "Markdown",
        });
      } else {
        await applyProvider(ctx, thread, provider);
      }
      return true;
    }
    if (!isLauncher(thread)) {
      await ctx.reply("⚠️ an existing topic can't change agent — choose it in the launcher.", {
        message_thread_id: thread,
      });
      return true;
    }
    const current = nextProvider ?? cfg.provider;
    void askPick(bot, {
      threadId: thread,
      title: "agent for the next session",
      groups: [providerGroup(current, cfg.provider)],
    })
      .then(({ picks }) =>
        applyProvider(ctx, thread, asProvider(picks.p ?? null, cfg.provider), false),
      )
      .catch((err) => console.warn(`[${cmd}] applying the picked value failed:`, String(err)));
    return true;
  }

  if (cmd === "/effort" || cmd === "/model") {
    const topic = isLauncher(thread) ? undefined : getTopic(thread!);
    const provider = topic?.provider ?? nextProvider ?? cfg.provider;
    const arg = ctx.message.text.trim().split(/\s+/)[1];
    const isEffort = cmd === "/effort";
    if (arg) {
      const value = isEffort ? parseEffort(arg, provider) : parseModel(arg, provider);
      if (value === undefined) {
        await ctx.reply(isEffort ? effortUsage(provider) : modelUsage(provider), {
          message_thread_id: thread,
        });
        return true;
      }
      if (isEffort) await applyEffort(ctx, thread, value as Effort);
      else await applyModel(ctx, thread, value as Model);
      return true;
    }
    // Nothing named — same effect, chosen with the buttons instead. Detached
    // like the launch picker: waiting on a button from inside a handler would
    // block the very callback that settles it.
    const inLauncher = isLauncher(thread);
    const where = inLauncher ? "the next session" : "this topic";
    const cwd = topic?.cwd ?? cfg.defaultCwd;
    void askPick(bot, {
      threadId: thread,
      title: `${isEffort ? "effort" : "model"} for ${where}`,
      groups: isEffort
        ? [
            effortGroup(
              inLauncher ? (nextEffort ?? null) : (topic?.effort ?? null),
              cwd,
              provider,
            ),
          ]
        : [modelGroup(inLauncher ? (nextModel ?? null) : (topic?.model ?? null), provider)],
    })
      .then(({ picks }) =>
        isEffort
          ? applyEffort(ctx, thread, asEffort(picks.e ?? null, provider), false)
          : applyModel(ctx, thread, asModel(picks.m ?? null), false),
      )
      .catch((err) => console.warn(`[${cmd}] applying the picked value failed:`, String(err)));
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

  const provider = t?.provider ?? nextProvider ?? cfg.provider;
  // Asking the provider for plan limits can take a few seconds (and may have
  // to start a child), so post the local tally first and fill the rest in.
  const sent = await ctx.reply(`${local}\n\n⏳ _checking plan limits…_`, {
    message_thread_id: thread,
    parse_mode: "Markdown",
  });

  let plan: string;
  try {
    const limits =
      provider === "codex" ? await fetchCodexPlanLimits() : await fetchPlanLimits();
    plan = planLimitsText(limits, providerLabel(provider));
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

const cancelTurnKeyboard = (threadId: number): InlineKeyboard =>
  new InlineKeyboard().text("✖️ Cancel", `s:${threadId}`);

/** A topic's permanent button stops whichever turn is currently running. */
function registerSessionCancelButtons(): void {
  bot.on("callback_query:data", async (ctx, next) => {
    const match = /^s:(\d+)$/.exec(ctx.callbackQuery.data);
    if (!match) return next();
    if (ctx.from.id !== cfg.allowedUserId || ctx.callbackQuery.message?.chat.id !== cfg.chatId) {
      return void ctx.answerCallbackQuery({ text: "Not authorized." }).catch(() => {});
    }

    const threadId = Number(match[1]);
    const session = liveSession(threadId);
    let stopped = false;
    try {
      stopped = (await session?.interrupt()) ?? false;
    } catch (err) {
      console.warn(`[cancel] interrupting ${threadId} failed:`, String(err));
      return void ctx.answerCallbackQuery({ text: "Couldn't stop the turn." }).catch(() => {});
    }

    if (!stopped) {
      return void ctx.answerCallbackQuery({ text: "Nothing is running." }).catch(() => {});
    }
    await ctx.answerCallbackQuery({ text: "Stopped" }).catch(() => {});
  });
}

/** Provider-neutral message; each SDK gets the image representation it accepts. */
const contentOf = (text: string, images: ImagePart[]): AgentInput => ({ text, images });

/**
 * Spin up a new topic + session for a launcher message.
 *
 * Detached on purpose: grammy handles updates one at a time, and this waits on
 * the effort picker — buttons whose presses arrive as updates of their own.
 * Awaiting it inside the handler would stall the very callbacks it waits for.
 * Each launcher message gets its own picker, so two launches never queue behind
 * each other.
 */
async function launch(
  ctx: any,
  text: string,
  images: ImagePart[],
  sources: any[] = [ctx],
): Promise<void> {
  const { cwd, prompt } = resolveCwd(text);
  const title = placeholderTitle(prompt || "image");
  const provider = nextProvider ?? cfg.provider;

  // Nothing exists yet: the model and the effort are chosen first — in one
  // picker, so a launch costs one message and one wait — and only then is the
  // topic created. An untouched picker falls through in seconds, so a launch
  // nobody answers still starts, but once the user reaches for a button the
  // launch waits for them to finish.
  const { picks, cancelled, messageId } = await askPick(bot, {
    threadId: cfg.launcherThreadId,
    title: `«${title}»`,
    groups: [
      modelGroup(nextModel ?? null, provider),
      effortGroup(nextEffort ?? null, cwd, provider),
    ],
    firstWaitMs: LAUNCH_WAIT_MS,
    rewritten: true,
    allowCancel: true,
  });
  if (cancelled) return;
  const effort = asEffort(picks.e ?? null, provider);
  const model = asModel(picks.m ?? null);
  nextEffort = undefined;
  nextModel = undefined;
  nextProvider = undefined;

  const topic = await ctx.api.createForumTopic(cfg.chatId, title);
  const tid = topic.message_thread_id;
  createTopic({ threadId: tid, cwd, title, provider, effort, model });

  // The picker becomes the launch line: one message for one launch, rather than
  // the settled picker and a "→ …" note sitting one above the other.
  const line =
    `→ «${title}»  (cwd: ${cwd})` +
    `  🧠 ${providerLabel(provider)}` +
    `  🤖 ${modelLabel(model, defaultModel(provider), provider)}` +
    `  ⚙️ ${effortLabel(effort, defaultEffort(cwd, provider))}`;
  const posted =
    messageId !== null &&
    (await ctx.api
      .editMessageText(cfg.chatId, messageId, line)
      .then(() => true)
      .catch(() => false));
  if (!posted) await ctx.reply(line, { message_thread_id: cfg.launcherThreadId });

  // The launcher message lives in another topic — repeat it here so the
  // thread reads as a whole conversation.
  const echoText = () =>
    ctx.api.sendMessage(cfg.chatId, prompt, {
      message_thread_id: tid,
      reply_markup: cancelTurnKeyboard(tid),
    });
  try {
    // Attachments are copied verbatim. For an album, the first successful copy
    // owns the permanent stop button and every source item stays visible.
    if (sources.some((source) => source.message.text === undefined)) {
      let copied = false;
      for (const source of sources) {
        if (source.message.text !== undefined) continue;
        try {
          await ctx.api.copyMessage(cfg.chatId, cfg.chatId, source.message.message_id, {
            message_thread_id: tid,
            ...(!copied ? { reply_markup: cancelTurnKeyboard(tid) } : {}),
          });
          copied = true;
        } catch (err) {
          console.warn(`[launch] copying message ${source.message.message_id} failed:`, String(err));
        }
      }
      if (!copied) await echoText();
    } else await echoText();
  } catch (err) {
    console.warn(`[launch] echoing the prompt into ${tid} failed:`, String(err));
  }

  await sessionFor(bot, { thread_id: tid, cwd, session_id: null, provider, effort, model }).send(
    contentOf(prompt, images),
  );
}

/** Route one inbound user message (with any images already downloaded). */
async function route(
  ctx: any,
  text: string,
  images: ImagePart[],
  sources: any[] = [ctx],
): Promise<void> {
  const thread: number | undefined = ctx.message.message_thread_id;

  // ---- A) Launcher: spin up a new topic + session -----------------------
  if (isLauncher(thread)) {
    void launch(ctx, text, images, sources).catch(async (err) => {
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

  // Claude receives this at its next step. Codex's SDK cannot steer a running
  // turn, so the same input becomes the next turn without interrupting it.
  await sessionFor(bot, t).send(contentOf(text, images));
}

/** Single-user gate + right-forum check, shared by every message handler. */
const mine = (ctx: any): boolean =>
  ctx.from?.id === cfg.allowedUserId && ctx.chat.id === cfg.chatId;

bot.on("message:text", async (ctx) => {
  if (!mine(ctx)) return;
  const text = ctx.message.text;

  // Commands (e.g. /usage) are handled here; anything else that merely starts
  // with a slash — a `/path` cwd prefix, above all — is a prompt like any other.
  if (text.startsWith("/") && (await handleCommand(ctx, ctx.message.message_thread_id))) return;

  await route(ctx, text, []);
});

/** Caption first, then what came with it: the caption is what titles a topic. */
const withNote = (caption: string, note: string): string =>
  caption ? `${caption}\n\n${note}` : note;

/** Turn one non-text Telegram update into provider-neutral agent input. */
async function contentFrom(ctx: any): Promise<AgentInput | null> {
  const thread = ctx.message.message_thread_id;
  const caption = ctx.message.caption?.trim() ?? "";
  const inbound = classify(ctx.message);
  if (!inbound) {
    // Telegram's own chatter carries nothing to pass on. Anything else that
    // got this far is a real message we can't read, and going quiet about it
    // is exactly how a message full of intent reaches nobody.
    if (isService(ctx.message)) return null;
    await ctx
      .reply("⚠️ I can't read that kind of message — try sending it as a file.", {
        message_thread_id: thread,
      })
      .catch(() => {});
    return null;
  }

  if (inbound.as === "text") {
    return contentOf(withNote(caption, `[${inbound.label}]`), []);
  }

  if (inbound.as === "image") {
    let image: ImagePart;
    try {
      image = await fetchImage(ctx.api, inbound.fileId, inbound.mime, inbound.uniqueId);
    } catch (err) {
      console.warn("[media] fetching the image failed:", String(err));
      await ctx
        .reply(`⚠️ couldn't fetch that image: ${String(err)}`, { message_thread_id: thread })
        .catch(() => {});
      return null;
    }
    return contentOf(caption, [image]);
  }

  // Anything with bytes behind it that the model can't look at: saved next to
  // the bot, named by what it is, and handed over as a path.
  let file: DocumentPart;
  try {
    file = await fetchDocument(ctx.api, inbound);
  } catch (err) {
    console.warn(`[media] fetching the ${inbound.kind} failed:`, String(err));
    await ctx
      .reply(`⚠️ couldn't fetch that ${inbound.kind}: ${String(err)}`, { message_thread_id: thread })
      .catch(() => {});
    return null;
  }
  return contentOf(
    withNote(caption, `[${inbound.label}, ${humanSize(file.size)}]\n${file.path}`),
    [],
  );
}

async function routeMediaGroup(sources: any[]): Promise<void> {
  const parts = (await Promise.all(sources.map(contentFrom))).filter(
    (part): part is AgentInput => part !== null,
  );
  if (!parts.length) return;
  await route(
    sources[0],
    parts.map((part) => part.text).filter(Boolean).join("\n\n"),
    parts.flatMap((part) => part.images),
    sources,
  );
}

// Telegram emits every album item as a separate update and has no explicit
// final marker. Half a second after the last item is the earliest safe send.
const mediaGroups = new MediaGroupCollector<any>(500, (sources) => {
  void routeMediaGroup(sources).catch((err) => console.error("[media-group] failed:", err));
});

bot.on("message", async (ctx) => {
  if (!mine(ctx)) return;
  const groupId = ctx.message.media_group_id;
  if (groupId) {
    const key = `${ctx.chat.id}:${ctx.message.message_thread_id ?? 0}:${groupId}`;
    mediaGroups.add(key, ctx);
    return;
  }

  const content = await contentFrom(ctx);
  if (content) await route(ctx, content.text, content.images);
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
  console.log(
    `[bot] permission=${cfg.permission} provider=${cfg.provider} ` +
      `model=${defaultModel(cfg.provider)}`,
  );

  await bot.api.setMyCommands([
    { command: "usage", description: "Tokens/cost here (or all in the launcher) + plan limits" },
    { command: "provider", description: "Next session agent: Claude or Codex" },
    { command: "effort", description: "Reasoning effort: /effort high, or /effort for buttons" },
    { command: "model", description: "Model: /model sonnet, or /model for buttons" },
    { command: "stop", description: "Interrupt the turn running in this topic" },
    { command: "resume", description: "Shell command to continue this session in a terminal" },
    { command: "id", description: "Agent session id of this topic" },
  ]);

  // Each callback owner passes unknown buttons to the next one. Permission
  // prompts are last and answer anything left over.
  registerPickerButtons(bot);
  registerSessionCancelButtons();
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
