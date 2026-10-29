import { Bot, HttpError, InlineKeyboard } from "grammy";
import { setTimeout as delay } from "node:timers/promises";
import { progressLevels, toolcallModes, type Progress, type Toolcalls } from "../telegram/activity.ts";
import { setActivity } from "../storage/db.ts";
import { cfg } from "../config/env.ts";
import { transcribe } from "../transcription/client.ts";
import { escapeHtml } from "../telegram/html.ts";
import { botCommands, parseCommand, type ParsedCommand } from "../telegram/commands.ts";
import { fetchCodexPlanLimits } from "../providers/codex/limits.ts";
import { fetchCodexSessionUsage, type CodexSessionUsage } from "../providers/codex/session-usage.ts";
import {
  classify,
  fetchDocument,
  fetchImage,
  humanSize,
  isService,
  type DocumentPart,
  type ImagePart,
} from "../telegram/media.ts";
import { existingFolders, isDirectory, placeholderTitle, resolveCwd } from "../sessions/cwd.ts";
import {
  asEffort,
  defaultEffort,
  effortGroup,
  effortLabel,
  effortUsage,
  parseEffort,
  type Effort,
} from "../config/effort.ts";
import {
  asModel,
  defaultModel,
  modelGroup,
  modelLabel,
  modelUsage,
  parseModel,
  type Model,
} from "../config/model.ts";
import { askPick, LAUNCH_WAIT_MS, registerPickerButtons, type PickGroup, type Picks } from "../telegram/picker.ts";
import {
  launchPicker,
  modelPicker,
  presetName,
  providerIcon,
  settingsLine,
  type LaunchChoice,
} from "../telegram/presets.ts";
import { cloneSettings, NO_SETTINGS, type ModelSettings, type Preset } from "../config/presets.ts";
import {
  asServiceTier,
  serviceTierGroup,
  serviceTierLabel,
} from "../config/service-tier.ts";
import { fmtTokens } from "../shared/fmt.ts";
import { startHeartbeat } from "./heartbeat.ts";
import { fetchPlanLimits } from "../providers/claude/limits.ts";
import { claudeWeeklyCalibration, claudeWeeklyRatio } from "../providers/claude/weekly.ts";
import { claudeCalibrationText, planLimitsText } from "../telegram/limits.ts";
import { MediaGroupCollector } from "../telegram/media-group.ts";
import { richText } from "../telegram/rich.ts";
import { registerPermissionButtons } from "../telegram/permission.ts";
import { registerCapacityButtons } from "../telegram/capacity.ts";
import { registerQuotaButtons } from "../telegram/quota.ts";
import { anyLiveQuery, capacityRetrySettingsChanged, liveSession, sessionFor, type AgentInput } from "../sessions/topic.ts";
import { sideTurnReady } from "../sessions/side-turn.ts";
import {
  asProvider,
  parseProvider,
  providerGroup,
  providerLabel,
  type Provider,
} from "../config/provider.ts";
import { startSweep } from "./sweep.ts";
import {
  createTopic,
  getTopic,
  getDefaultProgress,
  setOpenRouterSettings,
  setModelSettings,
  setDefaultProgress,
  getCapacityRetryMinutes,
  setCapacityRetryMinutes,
  setEffort,
  setModel,
  setStatus,
  totals,
  codexUsageTopics,
  type Topic,
} from "../storage/db.ts";

const bot = new Bot(cfg.token);

const TOPIC_CREATE_ATTEMPTS = 5;
const TOPIC_CREATE_RETRY_DELAY_MS = 2_000;

/** Replies produced synchronously from an inbound update do not need to buzz
 * the phone the user is already holding. Delayed agent output stays audible. */
const replySilently = (
  ctx: any,
  text: string,
  other: Record<string, unknown> = {},
): Promise<any> => ctx.reply(text, { ...other, disable_notification: true });

const isLauncher = (threadId: number | undefined) =>
  threadId === undefined || threadId === cfg.launcherThreadId;

const fmt = fmtTokens;

const topicSettings = (t: Topic): ModelSettings => ({
  model: t.model,
  effort: t.effort,
  serviceTier: t.service_tier,
  openrouter: t.openrouter_settings,
});

function topicUsageText(t: Topic, native?: CodexSessionUsage | null): string {
  const preset = presetName(t.provider, topicSettings(t));
  return (
    `📊 *${t.title}*\n` +
    `turns: ${t.turns}\n` +
    `agent: ${providerLabel(t.provider)}\n` +
    `model: ${modelLabel(t.model, defaultModel(t.provider), t.provider)}\n` +
    (preset ? `preset: ${preset}\n` : "") +
    (t.provider === "openrouter"
      ? ""
      : `effort: ${effortLabel(t.effort, defaultEffort(t.cwd, t.provider))}\n`) +
    (t.provider === "codex" ? `mode: ${serviceTierLabel(t.service_tier)}\n` : "") +
    `tokens: ${fmt(native?.inputTokens ?? t.in_tokens)} in / ${fmt(native?.outputTokens ?? t.out_tokens)} out\n` +
    `cost: ${t.provider !== "codex" && t.cost_known ? `$${t.cost_usd.toFixed(4)}` : "unavailable"}` +
    (t.provider === "codex"
      ? native ? "\n_tokens from persisted Codex logs + agents; /btw excluded_"
        : "\n_recorded tokens; older Codex turns may be incomplete_"
      : "")
  );
}

function totalsText(s = totals(), nativeCodex = false): string {
  const { provider, settings, preset } = nextLaunch();
  return (
    `📊 *All topics*\n` +
    `topics: ${s.topics} · turns: ${s.turns}\n` +
    `next session agent: ${providerLabel(provider)}\n` +
    (preset ? `next session preset: ${preset}\n` : "") +
    `next session model: ${modelLabel(settings.model, defaultModel(provider), provider)}\n` +
    (provider === "openrouter"
      ? ""
      : `next session effort: ${effortLabel(settings.effort, defaultEffort(cfg.defaultCwd, provider))}\n`) +
    (provider === "codex" ? `next session mode: ${serviceTierLabel(settings.serviceTier)}\n` : "") +
    `tokens: ${fmt(s.in_tokens)} in / ${fmt(s.out_tokens)} out\n` +
    `cost: ${s.cost_known ? `$${s.cost_usd.toFixed(4)}` : "unavailable"}` +
    (nativeCodex ? "\n_Codex tokens from available persisted logs; /btw excluded_" : "")
  );
}

/**
 * `/provider`, `/effort` and `/model` in the launcher belong to the next
 * session only: they are consumed by the launch that follows, where they
 * arrive as the picker's pre-selection. Unset fields are no choice at all.
 */
let nextProvider: Provider | undefined;
let nextSettings: Partial<ModelSettings> = {};
let defaultProgress: Progress = getDefaultProgress();
let nextToolcalls: Toolcalls = "off";

/** What the next launch starts on if nobody touches its picker. */
function nextLaunch(): LaunchChoice {
  const provider = nextProvider ?? cfg.provider;
  return (
    launchPicker(provider, nextSettings)?.selected(null) ?? {
      provider,
      settings: { ...NO_SETTINGS, ...nextSettings },
      preset: null,
    }
  );
}

function resetNextSession(): void {
  nextProvider = undefined;
  nextSettings = {};
}

/**
 * Where a `/effort` or `/model` lands. `null` is the launcher — the choice is
 * held for the next session; `undefined` means there is nowhere to put it, and
 * the caller has already said so.
 */
async function target(ctx: any, thread: number | undefined): Promise<Topic | null | undefined> {
  if (isLauncher(thread)) return null;
  const t = getTopic(thread!);
  if (t) return t;
  await replySilently(ctx, "⚠️ run this inside a session topic, not here.", {
    message_thread_id: thread,
  });
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
    const { provider, settings } = nextLaunch();
    // Built on what the launch would start with, so one change keeps the rest.
    nextSettings = { ...settings, effort: level };
    if (announce) {
      const label = effortLabel(level, defaultEffort(cfg.defaultCwd, provider));
      await replySilently(ctx, `⚙️ next session: ${label}`, { message_thread_id: thread });
    }
    return;
  }
  const s = liveSession(t.thread_id);
  if (s) s.setEffort(level);
  else setEffort(t.thread_id, level);
  if (announce) {
    await replySilently(ctx, `⚙️ effort: ${effortLabel(level, defaultEffort(t.cwd, t.provider))}`, {
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
    const { provider, settings } = nextLaunch();
    nextSettings = {
      ...settings,
      model,
      // A bare OpenRouter model drops the preset's request parameters.
      ...(provider === "openrouter"
        ? { openrouter: model ? { model, preset: null } : { model: null } }
        : {}),
    };
    if (announce) {
      await replySilently(
        ctx,
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
  else if (t.provider === "openrouter") {
    setOpenRouterSettings(t.thread_id, model ? { model, preset: null } : { model: null });
    setModel(t.thread_id, model);
  } else setModel(t.thread_id, model);
  if (announce) {
    await replySilently(
      ctx,
      `🤖 model: ${modelLabel(model, defaultModel(t.provider), t.provider)}`,
      { message_thread_id: thread },
    );
  }
}

/** Apply every setting of one preset at once. */
async function applyPreset(ctx: any, thread: number | undefined, preset: Preset): Promise<void> {
  const t = await target(ctx, thread);
  if (t === undefined) return;
  if (t === null) {
    nextProvider = preset.provider;
    nextSettings = cloneSettings(preset.settings);
    return;
  }
  // `/model` only offers a topic its own provider's presets.
  if (preset.provider !== t.provider) return;
  const s = liveSession(t.thread_id);
  if (s) s.setSettings(preset.settings);
  else setModelSettings(t.thread_id, cloneSettings(preset.settings));
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
    await replySilently(
      ctx,
      "⚠️ an existing topic can't change agent — choose it in the launcher.",
      { message_thread_id: thread },
    );
    return;
  }
  resetNextSession();
  nextProvider = provider;
  if (announce) {
    await replySilently(ctx, `🧠 next session agent: ${providerLabel(provider)}`, {
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
async function sessionTopic(
  ctx: any,
  thread: number | undefined,
  allowLive = false,
): Promise<Topic | undefined> {
  const t = thread !== undefined && !isLauncher(thread) ? getTopic(thread) : undefined;
  if (!t) {
    await replySilently(ctx, "⚠️ run this inside a session topic, not here.", {
      message_thread_id: thread,
    });
    return;
  }
  if (!sideTurnReady(t.session_id, allowLive && Boolean(liveSession(t.thread_id)))) {
    await replySilently(ctx, "⚠️ this topic has no session id yet — send a message first.", {
      message_thread_id: thread,
    });
    return;
  }
  return t;
}

/** Shared by /model, /effort and capacity recovery's Change model button. */
async function chooseModelOrEffort(ctx: any, thread: number | undefined, isEffort: boolean, requireConfirm = false): Promise<boolean> {
  const topic = isLauncher(thread) ? undefined : getTopic(thread!);
  const provider = topic?.provider ?? nextProvider ?? cfg.provider;
  const inLauncher = isLauncher(thread);
  const where = inLauncher ? "the next session" : "this topic";
  const cwd = topic?.cwd ?? cfg.defaultCwd;
  const current = inLauncher ? nextLaunch().settings : topic ? topicSettings(topic) : NO_SETTINGS;
  const models = isEffort ? undefined : modelPicker(provider, current, inLauncher);
  const { picks, cancelled, messageId } = await askPick(bot, {
    threadId: thread,
    title: `${isEffort ? "effort" : "model"} for ${where}`,
    allowCancel: true,
    requireConfirm,
    groups: [models?.group ?? effortGroup(current.effort, cwd, provider)],
  });
  if (cancelled || messageId === null) return false;
  // A topic may have been deleted while the picker was on screen.
  if (topic && !getTopic(topic.thread_id)) return false;
  if (!models) {
    await applyEffort(ctx, thread, asEffort(picks.e ?? null, provider), false);
    return true;
  }
  const choice = models.selected(picks.m ?? null);
  if (choice.kind === "preset") await applyPreset(ctx, thread, choice.preset);
  else await applyModel(ctx, thread, choice.model, false);
  return true;
}

async function chooseCapacityRetryMinutes(threadId: number | undefined): Promise<void> {
  const current = getCapacityRetryMinutes();
  const resume = threadId === undefined ? undefined : liveSession(threadId)?.capacity.pause();
  try {
    const values = [...new Set([0, 1, 3, 5, 10, 15, 30, 60, current])].sort((a, b) => a - b);
    const { picks, cancelled, messageId } = await askPick(bot, {
      threadId,
      title: "Global capacity retry window · all Codex topics\nMinutes: 0 = off, up to 60. Retries every 30 seconds. /retry <0–60> sets any duration.",
      allowCancel: true,
      groups: [{ key: "r", perRow: 4, initial: String(current), fallback: "3",
        options: values.map(value => ({ value: String(value), label: value === 0 ? "Off" : `${value} min` })),
        summary: value => `Global capacity retry window: ${value ?? current} min · every 30s`,
      }],
    });
    if (cancelled || messageId === null) return;
    setCapacityRetryMinutes(Number(picks.r ?? current));
    await capacityRetrySettingsChanged();
  } finally { resume?.(); }
}

/** Run a resolved command without forwarding its original text as a prompt. */
async function handleCommand(
  ctx: any,
  thread: number | undefined,
  parsed: Extract<ParsedCommand, { kind: "command" }>,
): Promise<void> {
  const { command: cmd, args } = parsed;

  if (cmd === "/retry") {
    if (args) {
      if (!/^\d+$/.test(args) || Number(args) > 60) {
        await replySilently(ctx, "Usage: /retry <0–60 minutes>; 0 disables automatic capacity retries globally.", { message_thread_id: thread });
      } else {
        setCapacityRetryMinutes(Number(args));
        await capacityRetrySettingsChanged();
        await replySilently(ctx, `Global capacity retry window: ${Number(args)} min · every 30s (all Codex topics).`, { message_thread_id: thread });
      }
    } else void chooseCapacityRetryMinutes(thread).catch(err => console.warn("[retry] picker failed:", String(err)));
    return;
  }

  if (cmd === "/progress" || cmd === "/toolcalls") {
    const setting = cmd === "/progress" ? "progress" : "toolcalls";
    const values = setting === "progress" ? progressLevels : toolcallModes;
    const launcher = isLauncher(thread);
    const topic = launcher ? undefined : getTopic(thread!);
    if (!launcher && !topic) {
      await replySilently(ctx, "⚠️ Use this command in a session topic or the launcher.", { message_thread_id: thread });
      return;
    }
    const current = topic?.[setting] ?? (setting === "progress" ? defaultProgress : nextToolcalls);
    const apply = (value: string) => {
      if (launcher) {
        if (setting === "progress") {
          defaultProgress = value as Progress;
          setDefaultProgress(defaultProgress);
        }
        else nextToolcalls = value as Toolcalls;
      } else setActivity(thread!, setting, value as Progress | Toolcalls);
    };
    const arg = args.split(/\s+/)[0]?.toLowerCase();
    if (arg) {
      if ((values as readonly string[]).includes(arg)) {
        apply(arg);
        const scope = launcher
          ? setting === "progress" ? " (default for new sessions)" : " (next session)"
          : "";
        await replySilently(ctx, `${setting}: ${arg}${scope}`, { message_thread_id: thread });
      } else await replySilently(ctx, `Usage: ${cmd} ${values.join(" | ")}`, { message_thread_id: thread });
    } else {
      void askPick(bot, {
        threadId: thread,
        title: launcher
          ? setting === "progress" ? "progress default for new sessions" : "toolcalls for the next session"
          : `${setting} for this topic`,
        allowCancel: true,
        groups: [{ key: "a", options: values.map(value => ({ value, label: value })), perRow: 3,
          initial: current,
          fallback: "off",
          summary: value => launcher && setting === "progress"
            ? `progress default for new sessions: ${value}`
            : `${setting}: ${value}` }],
      }).then(({ picks, cancelled }) => {
        if (!cancelled) apply(picks.a ?? current);
      }).catch(err => console.warn(`[${setting}] picker failed:`, String(err)));
    }
    return;
  }

  if (cmd === "/id") {
    const t = await sessionTopic(ctx, thread);
    if (t) {
      await replySilently(ctx, `\`${t.session_id}\``, {
        message_thread_id: thread,
        parse_mode: "Markdown",
      });
    }
    return;
  }

  if (cmd === "/resume") {
    const t = await sessionTopic(ctx, thread);
    if (t) {
      const resume =
        t.provider === "openrouter"
          ? `OpenRouter history is stored in ${cfg.openrouterHistoryPath}/${t.session_id}.jsonl and resumes automatically`
          : t.provider === "codex"
          ? `codex resume ${t.session_id}`
          : `claude --resume ${t.session_id}`;
      await replySilently(ctx, `\`\`\`\ncd ${shq(t.cwd)} && ${resume}\n\`\`\``, {
        message_thread_id: thread,
        parse_mode: "Markdown",
      });
    }
    return;
  }

  if (cmd === "/btw") {
    const prompt = args;
    if (!prompt) {
      await replySilently(ctx, "⚠️ usage: `/btw <message>`", {
        message_thread_id: thread,
        parse_mode: "Markdown",
        reply_parameters: { message_id: ctx.message.message_id },
      });
      return;
    }
    const t = await sessionTopic(ctx, thread, true);
    if (!t) return;
    // Detached: a side turn can run alongside the main turn, and Telegram's
    // update loop must remain free for commands and callback queries.
    void sessionFor(bot, t)
      .btw(contentOf(prompt, []), ctx.message.message_id)
      .catch((err) => console.error(`[btw:${thread}] failed:`, err));
    return;
  }

  if (cmd === "/compact") {
    const t = await sessionTopic(ctx, thread);
    if (!t) return;
    const note = await sessionFor(bot, t).compact(args.trim());
    if (note) await replySilently(ctx, note, { message_thread_id: thread });
    return;
  }

  if (cmd === "/provider") {
    const arg = args.split(/\s+/)[0];
    if (arg) {
      const provider = parseProvider(arg);
      if (!provider) {
        await replySilently(
          ctx,
          `⚠️ unknown agent. Use ${cfg.openrouterEnabled ? "`claude`, `codex`, or `openrouter`" : "`claude` or `codex`"}.`,
          {
          message_thread_id: thread,
          parse_mode: "Markdown",
          },
        );
      } else {
        if (provider === "openrouter" && !cfg.openrouterEnabled) {
          await replySilently(ctx, "⚠️ OpenRouter is disabled: set a non-empty OPENROUTER_API_KEY.", {
            message_thread_id: thread,
          });
        } else await applyProvider(ctx, thread, provider);
      }
      return;
    }
    if (!isLauncher(thread)) {
      await replySilently(ctx, "⚠️ an existing topic can't change agent — choose it in the launcher.", {
        message_thread_id: thread,
      });
      return;
    }
    const current = nextProvider ?? cfg.provider;
    void askPick(bot, {
      threadId: thread,
      title: "agent for the next session",
      groups: [providerGroup(current, cfg.provider, cfg.openrouterEnabled)],
    })
      .then(({ picks }) =>
        applyProvider(ctx, thread, asProvider(picks.p ?? null, cfg.provider), false),
      )
      .catch((err) => console.warn(`[${cmd}] applying the picked value failed:`, String(err)));
    return;
  }

  if (cmd === "/effort" || cmd === "/model") {
    const topic = isLauncher(thread) ? undefined : getTopic(thread!);
    const provider = topic?.provider ?? nextProvider ?? cfg.provider;
    const arg = args.split(/\s+/)[0];
    const isEffort = cmd === "/effort";
    if (isEffort && provider === "openrouter") {
      await replySilently(
        ctx,
        "⚠️ OpenRouter reasoning is configured in PRESETS; choose a preset with `/model`.",
        { message_thread_id: thread, parse_mode: "Markdown" },
      );
      return;
    }
    if (arg) {
      const value = isEffort ? parseEffort(arg, provider) : parseModel(arg, provider);
      if (value === undefined) {
        await replySilently(ctx, isEffort ? effortUsage(provider) : modelUsage(provider), {
          message_thread_id: thread,
        });
        return;
      }
      if (isEffort) await applyEffort(ctx, thread, value as Effort);
      else await applyModel(ctx, thread, value as Model);
      return;
    }
    // Detached so Telegram can process the buttons that settle the picker.
    void chooseModelOrEffort(ctx, thread, isEffort)
      .catch(err => console.warn(`[${cmd}] applying the picked value failed:`, String(err)));
    return;
  }

  if (cmd === "/stop") {
    const s = thread !== undefined && !isLauncher(thread) ? liveSession(thread) : undefined;
    let stopped = false;
    if (s) {
      try {
        stopped = await s.interrupt();
      } catch (err) {
        console.warn(`[stop] interrupting ${thread} failed:`, String(err));
        await replySilently(ctx, `⚠️ couldn't stop it: ${String(err)}`, {
          message_thread_id: thread,
        });
        return;
      }
    }
    if (!stopped) {
      await replySilently(ctx, "⚠️ nothing running here.", { message_thread_id: thread });
    }
    return;
  }

  if (cmd !== "/usage") return;

  // In a task topic -> that topic's usage; in the launcher -> grand total.
  const t = thread !== undefined ? getTopic(thread) : undefined;
  let local = t ? topicUsageText(t) : totalsText();

  const provider = t?.provider ?? nextProvider ?? cfg.provider;
  if (provider === "openrouter" && t) {
    await replySilently(ctx, local, { message_thread_id: thread, parse_mode: "Markdown" });
    return;
  }
  // Asking the provider for plan limits can take a few seconds (and may have
  // to start a child), so post the local tally first and fill the rest in.
  const sent = await replySilently(ctx, `${local}\n\n⏳ _checking plan limits…_`, {
    message_thread_id: thread,
    parse_mode: "Markdown",
  });

  let plan: string;
  try {
    if (t?.provider === "codex" && t.session_id) {
      local = topicUsageText(t, await fetchCodexSessionUsage(t.session_id, t.service_tier));
    } else if (!t) {
      const sum = totals();
      let verified = false;
      const counted = new Set<string>();
      for (const topic of codexUsageTopics()) {
        try {
          const alreadyCounted = counted.has(topic.session_id!);
          const native = await fetchCodexSessionUsage(topic.session_id!, topic.service_tier, counted);
          if (!native && !alreadyCounted) continue;
          sum.in_tokens += (native?.inputTokens ?? 0) - topic.in_tokens;
          sum.out_tokens += (native?.outputTokens ?? 0) - topic.out_tokens;
          sum.cost_known = 0;
          verified = true;
        } catch (err) {
          console.warn(`[usage] native Codex tally for ${topic.session_id} failed:`, String(err));
        }
      }
      local = totalsText(sum, verified);
    }
  } catch (err) {
    console.warn("[usage] native Codex token tally failed:", String(err));
  }
  if (provider === "openrouter") {
    try {
      await ctx.api.editMessageText(ctx.chat.id, sent.message_id, local, { parse_mode: "Markdown" });
    } catch (err) {
      console.warn("[usage] editing the reply failed:", String(err));
    }
    return;
  }
  try {
    const limits =
      provider === "codex" ? await fetchCodexPlanLimits() : await fetchPlanLimits(anyLiveQuery());
    plan = planLimitsText(limits, providerLabel(provider));
    if (provider === "claude" && limits) plan += `\n${claudeCalibrationText(claudeWeeklyCalibration(), claudeWeeklyRatio())}`;
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
  return;
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

/** Separate model/effort/mode groups, for a bot with no presets configured. */
function settingGroups(provider: Provider, settings: ModelSettings, cwd: string): PickGroup[] {
  const model = modelGroup(settings.model, provider);
  if (provider === "openrouter") return [model];
  const effort = effortGroup(settings.effort, cwd, provider);
  return provider === "codex" ? [model, effort, serviceTierGroup(settings.serviceTier)] : [model, effort];
}

function settingsFromPicks(provider: Provider, picks: Picks, base: ModelSettings): ModelSettings {
  const model = asModel(picks.m ?? null);
  if (provider === "openrouter") {
    return { ...NO_SETTINGS, model, openrouter: model ? { model, preset: null } : base.openrouter };
  }
  return {
    model,
    effort: asEffort(picks.e ?? null, provider),
    serviceTier: provider === "codex" ? asServiceTier(picks.s ?? null) : null,
    openrouter: null,
  };
}

/**
 * A launch whose folder doesn't exist would only fail once the agent process
 * starts, with an error that never names the folder. Say so up front and let
 * the user move the launch into an existing project instead. `null` = no launch.
 */
async function chooseFolder(missing: string, title: string): Promise<string | null> {
  const folders = existingFolders();
  if (!folders.length) {
    await bot.api
      .sendMessage(cfg.chatId, `⚠️ folder ${missing} doesn't exist, and no configured project folder does either.`, {
        message_thread_id: cfg.launcherThreadId,
      })
      .catch((err) => console.warn("[launch] reporting a missing folder failed:", String(err)));
    return null;
  }
  const { picks, cancelled } = await askPick(bot, {
    threadId: cfg.launcherThreadId,
    title: `📁 ${missing} doesn't exist. Start «${title}» in:`,
    groups: [{
      key: "f",
      options: folders.map((f) => ({ value: f.cwd, label: f.name })),
      perRow: 3,
      initial: null,
      fallback: folders[0]!.cwd,
      summary: (value) => `📁 ${value ?? folders[0]!.cwd}`,
    }],
    allowCancel: true,
    requireConfirm: true,
  });
  return cancelled ? null : (picks.f ?? folders[0]!.cwd);
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
async function launch(
  ctx: any,
  text: string,
  images: ImagePart[],
  sources: any[] = [ctx],
): Promise<void> {
  const resolved = resolveCwd(text);
  const { prompt } = resolved;
  const title = placeholderTitle(prompt || "image");
  const cwd = isDirectory(resolved.cwd) ? resolved.cwd : await chooseFolder(resolved.cwd, title);
  if (cwd === null) return;
  const provider = nextProvider ?? cfg.provider;

  // Nothing exists yet: the provider, model, and effort are chosen first — in
  // one picker, so a launch costs one message and one wait — and only then is
  // the topic created. An untouched picker falls through in seconds, so a
  // launch nobody answers still starts, but once the user reaches for a button
  // the launch waits for them to finish.
  const presets = launchPicker(provider, nextSettings);
  const custom = { ...NO_SETTINGS, ...nextSettings };
  const { picks, cancelled, messageId } = await askPick(bot, {
    threadId: cfg.launcherThreadId,
    title: `«${title}»`,
    groups: presets ? [presets.group] : settingGroups(provider, custom, cwd),
    firstWaitMs: LAUNCH_WAIT_MS,
    rewritten: true,
    allowCancel: true,
  });
  if (cancelled) return;
  const choice: LaunchChoice = presets?.selected(picks.r ?? null) ?? {
    provider,
    settings: settingsFromPicks(provider, picks, custom),
    preset: null,
  };
  const { provider: selectedProvider, settings } = choice;
  const progress = defaultProgress;
  const toolcalls = nextToolcalls;
  nextToolcalls = "off";
  resetNextSession();

  let topic;
  for (let attempt = 1; ; attempt++) {
    try {
      topic = await ctx.api.createForumTopic(cfg.chatId, title);
      break;
    } catch (err) {
      if (!(err instanceof HttpError) || attempt >= TOPIC_CREATE_ATTEMPTS) throw err;
      console.warn(
        `[launch] createForumTopic failed; retry ${attempt}/${TOPIC_CREATE_ATTEMPTS - 1} ` +
          `in ${TOPIC_CREATE_RETRY_DELAY_MS}ms:`,
        String(err),
      );
      await delay(TOPIC_CREATE_RETRY_DELAY_MS);
    }
  }
  const tid = topic.message_thread_id;
  createTopic({
    threadId: tid,
    cwd,
    title,
    provider: selectedProvider,
    effort: settings.effort,
    model: settings.model,
    serviceTier: settings.serviceTier,
    openrouterSettings: settings.openrouter,
  });
  setActivity(tid, "progress", progress);
  setActivity(tid, "toolcalls", toolcalls);

  // The picker becomes the launch line: one message for one launch, rather than
  // the settled picker and a "→ …" note sitting one above the other.
  const line =
    `→ «${title}»  (cwd: ${cwd})  ${providerIcon(selectedProvider)} ${providerLabel(selectedProvider)} · ` +
    (choice.preset ?? settingsLine(selectedProvider, settings));
  const posted =
    messageId !== null &&
    (await ctx.api
      .editMessageText(cfg.chatId, messageId, line)
      .then(() => true)
      .catch(() => false));
  if (!posted) {
    await replySilently(ctx, line, { message_thread_id: cfg.launcherThreadId });
  }

  // The launcher message lives in another topic — repeat it here so the
  // thread reads as a whole conversation.
  const echoText = () =>
    ctx.api.sendMessage(cfg.chatId, prompt, {
      message_thread_id: tid,
      disable_notification: true,
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
            disable_notification: true,
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

  await sessionFor(bot, {
    thread_id: tid,
    cwd,
    session_id: null,
    provider: selectedProvider,
    effort: settings.effort,
    model: settings.model,
    service_tier: settings.serviceTier,
    openrouter_settings: settings.openrouter,
  }).send(contentOf(prompt, images));
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
      await replySilently(ctx, `❌ couldn't start that session: ${String(err)}`, {
        message_thread_id: cfg.launcherThreadId,
      }).catch(() => {});
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

  // An album's reply metadata may occur on any of its items.
  const parent = sources.map((source) => source.message.reply_to_message)
    .find((message) => message && !isService(message));
  await sessionFor(bot, t).send({
    ...contentOf(text, images),
    ...(parent ? { replyTo: {
      messageId: parent.message_id,
      text: parent.text ?? parent.caption ?? richText(parent) ?? "",
    } } : {}),
  });
}

/** Single-user gate + right-forum check, shared by every message handler. */
const mine = (ctx: any): boolean =>
  ctx.from?.id === cfg.allowedUserId && ctx.chat.id === cfg.chatId;

// Consume slash commands before any text/media can reach an agent, allowing
// cwd prefixes in the launcher. Albums are checked together below.
bot.on("message", async (ctx, next) => {
  if (!mine(ctx)) return;
  if (ctx.message.media_group_id) return next();
  const parsed = parseCommand(
    ctx.message.text ?? ctx.message.caption ?? richText(ctx.message) ?? "",
    botUsername,
    isLauncher(ctx.message.message_thread_id),
  );
  if (parsed.kind === "prompt") return next();
  if (parsed.kind === "command") {
    await handleCommand(ctx, ctx.message.message_thread_id, parsed);
  }
});

bot.on("message:text", async (ctx) => {
  if (!mine(ctx)) return;
  await route(ctx, ctx.message.text, []);
});

// Premium clients can send block-formatted messages that carry no `text`.
bot.on("message", async (ctx, next) => {
  if (!mine(ctx)) return;
  const text = richText(ctx.message);
  if (!text) return next();
  await route(ctx, text, []);
});

/** Caption first, then what came with it: the caption is what titles a topic. */
const withNote = (caption: string, note: string): string =>
  caption ? `${caption}\n\n${note}` : note;

/** Telegram's message cap, less room for the quote markup around the text. */
const MAX_TRANSCRIPT_ECHO = 3_900;

/**
 * Quote the transcript under the recording it came from, so the user sees
 * what the agent will read before the agent answers. Purely informational:
 * a failed post is logged and the message still goes through.
 */
async function showTranscript(ctx: any, heard: string): Promise<void> {
  const clipped = heard.length > MAX_TRANSCRIPT_ECHO ? `${heard.slice(0, MAX_TRANSCRIPT_ECHO)}…` : heard;
  const text = clipped
    ? `🎙 <blockquote expandable>${escapeHtml(clipped)}</blockquote>`
    : "🎙 <i>no speech recognised</i>";
  await replySilently(ctx, text, {
    message_thread_id: ctx.message.message_thread_id,
    parse_mode: "HTML",
    reply_parameters: { message_id: ctx.message.message_id, allow_sending_without_reply: true },
  }).catch((err) => console.warn("[media] posting the transcript failed:", String(err)));
}

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
    await replySilently(ctx, "⚠️ I can't read that kind of message — try sending it as a file.", {
      message_thread_id: thread,
    }).catch(() => {});
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
      await replySilently(ctx, `⚠️ couldn't fetch that image: ${String(err)}`, {
        message_thread_id: thread,
      }).catch(() => {});
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
    await replySilently(ctx, `⚠️ couldn't fetch that ${inbound.kind}: ${String(err)}`, {
      message_thread_id: thread,
    }).catch(() => {});
    return null;
  }
  const note = `[${inbound.label}, ${humanSize(file.size)}]\n${file.path}`;
  if (!inbound.speech || !cfg.transcription) return contentOf(withNote(caption, note), []);

  // The recording stays on disk beside its transcript, so the agent can go
  // back to the audio. A failed transcription still delivers the file.
  try {
    const heard = await transcribe(cfg.transcription, file.path);
    await showTranscript(ctx, heard);
    const said = heard
      ? "Transcript (automatic speech-to-text, so words may be misheard: infer the intended " +
        `meaning from context, and ask the user if it stays unclear):\n${heard}`
      : "Transcript: no speech recognised.";
    return contentOf(withNote(caption, `${note}\n${said}`), []);
  } catch (err) {
    console.warn(`[media] transcribing the ${inbound.kind} failed:`, String(err));
    await replySilently(ctx, `⚠️ couldn't transcribe that ${inbound.kind}, passing the file on: ${String(err)}`, {
      message_thread_id: thread,
    }).catch(() => {});
    return contentOf(withNote(caption, note), []);
  }
}

async function routeMediaGroup(sources: any[]): Promise<void> {
  for (const source of sources) {
    const parsed = parseCommand(
      source.message.caption ?? "",
      botUsername,
      isLauncher(source.message.message_thread_id),
    );
    if (parsed.kind === "prompt") continue;
    if (parsed.kind === "command") {
      await handleCommand(source, source.message.message_thread_id, parsed);
    }
    return;
  }
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

  await bot.api.setMyCommands([...botCommands]);

  // Each callback owner passes unknown buttons to the next one. Permission
  // prompts are last and answer anything left over.
  registerPickerButtons(bot);
  registerSessionCancelButtons();
  registerCapacityButtons(bot, async (threadId, action, messageId, ctx) => {
    if (action === "settings") return chooseCapacityRetryMinutes(threadId);
    const session = liveSession(threadId);
    const current = session?.capacity.owns(messageId) ?? false;
    if (action === "model") {
      const resume = current ? session?.capacity.pause() : undefined;
      try {
        const picked = await chooseModelOrEffort(ctx, threadId, false, true);
        if (picked && session?.capacity.owns(messageId)) await session.retryCapacity();
      } finally { resume?.(); }
      return;
    }
    if (!session || !current) return;
    if (action === "retry") await session.retryCapacity();
    else await session.interrupt();
  });
  registerQuotaButtons(bot, async (threadId, action, messageId) => {
    const session = liveSession(threadId);
    if (!session?.quota.owns(messageId)) return;
    if (action === "wait") await session.quota.start(messageId);
    else await session.interrupt();
  });
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
