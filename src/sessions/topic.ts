import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { progressInstruction, toolcallText } from "../telegram/activity.ts";
import type { Bot } from "grammy";
import type { Usage } from "./usage.ts";
import { createAgentSession } from "./factory.ts";
import type { AgentInput, AgentSession, AgentTurnResult, CompactionResult } from "./types.ts";
import { cfg } from "../config/env.ts";
import {
  codexSummaryParts,
  codexWeeklyPart,
  codexWeeklyPercent,
} from "../providers/codex/summary.ts";
import { fetchPlanLimits, sampleClaudeWeekly } from "../providers/claude/limits.ts";
import { fetchCodexPlanLimits } from "../providers/codex/limits.ts";
import {
  claudeSessionUsd,
  claudeWeeklyRatio,
  type WeeklyRatio,
  claudeWeeklyPart,
} from "../providers/claude/weekly.ts";
import { isPendingTitle } from "./cwd.ts";
import {
  addUsage,
  getTopic,
  setOpenRouterSettings,
  setModelSettings,
  setEffort,
  setModel,
  setSession,
  setTitle,
  touch,
} from "../storage/db.ts";
import { defaultEffort, effortLabel, type Effort } from "../config/effort.ts";
import { defaultModel, modelLabel, type Model } from "../config/model.ts";
import type { OpenRouterSettings } from "../config/openrouter-settings.ts";
import { presetName } from "../telegram/presets.ts";
import { cloneSettings, type ModelSettings } from "../config/presets.ts";
import { serviceTierLabel, type ServiceTier } from "../config/service-tier.ts";
import type { Provider } from "../config/provider.ts";
import { compactMs, fmtTokens, humanMs } from "../shared/fmt.ts";
import { clearPermissions, denyPending } from "../telegram/permission.ts";
import { TopicRenderer } from "../telegram/render.ts";
import { TurnStatus } from "../telegram/status.ts";
import { createTgChannel } from "../telegram/tg-tools.ts";
import { replyContext } from "../telegram/reply.ts";
import { CapacityRecovery } from "../telegram/capacity.ts";
import { QuotaRecovery } from "../telegram/quota.ts";
import { isQuotaFailure } from "./quota-retry.ts";

export type { AgentInput } from "./types.ts";

const COMPACTING = "🗜 compacting…";

/** How long a session with background tasks may stay silent before it is closed anyway. */
const BACKGROUND_HOLD_MS = 3 * 60 * 60_000;

/**
 * One live Agent SDK session per topic.
 *
 * Claude is fed by an async iterator that stays open between turns, so a new
 * message reaches it at its next step. Codex queues ordinary messages for its
 * next turn; replies to native asynchronous questions can steer its active turn.
 *
 * The child process is kept only while the topic is warm — after
 * `SESSION_IDLE_MINUTES` of silence it is shut down, and the next message
 * starts a fresh one resuming the same provider session id.
 */
export class TopicSession {
  private out: TopicRenderer;
  private agent: AgentSession;
  readonly capacity: CapacityRecovery;
  readonly quota: QuotaRecovery;
  private inputVersion = 0;
  private turnInputVersion = 0;

  // A settings change asked for mid-turn lands once that turn is over.
  private settingsDirty = false;

  // Per-turn state.
  private status: TurnStatus | null = null;
  private turnActive = false;
  private turnEffort: Effort = null;
  private turnModel: Model = null;
  private turnResolvedModel: string | null = null;
  private turnServiceTier: ServiceTier = null;
  private turnWeeklyBaseline: number | null = null;
  /** Claude: session dollars before the turn, and the $/1% ratio frozen for it. */
  private turnClaudeBaselineUsd: number | null = null;
  private turnClaudeRatio: WeeklyRatio | null = null;
  private sideTurns = 0;
  private closed = false;

  // Compaction: a /compact turn, and every compaction (manual or automatic) seen in a turn.
  private compactRequested = false;
  private turnCompact = false;
  private compacting = false;
  private turnCompactions: CompactionResult[] = [];

  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private idleSince = 0;

  constructor(
    private bot: Bot,
    readonly threadId: number,
    private cwd: string,
    private sessionId: string | null,
    readonly provider: Provider = "claude",
    private effortLevel: Effort = null,
    private modelId: Model = null,
    private serviceTier: ServiceTier = null,
    private openrouterSettings: OpenRouterSettings | null = null,
  ) {
    this.out = new TopicRenderer(bot.api, cfg.chatId, threadId);
    this.capacity = new CapacityRecovery(bot, threadId, this.out);
    this.quota = new QuotaRecovery(bot, threadId, this.out,
      () => this.provider === "codex" ? fetchCodexPlanLimits() : fetchPlanLimits(this.live),
      async () => {
        if (this.closed || this.turnActive) return false;
        touch(this.threadId);
        return await this.agent.retryQuota?.() ?? false;
      },
      () => this.modelId ?? defaultModel(this.provider),
    );
    const channel = createTgChannel(this.out, cwd);
    this.agent = createAgentSession({
      bot,
      threadId,
      cwd,
      sessionId,
      provider,
      effort: effortLevel,
      model: modelId,
      serviceTier,
      openrouter: openrouterSettings,
      channel,
      hooks: {
        beginTurn: () => this.beginTurn(),
        session: (id) => {
          this.sessionId = id;
          setSession(this.threadId, id);
        },
        model: (id) => {
          this.turnResolvedModel = id;
          this.status?.detailChanged();
        },
        text: (value) => this.out.hold(value),
        tool: async (name, input) => {
          this.status?.tool(name);
          const text = toolcallText(getTopic(this.threadId)?.toolcalls ?? "off", name, input);
          if (text) await this.out.sendText(text);
        },
        endTurn: (result) => this.endTurn(result),
        compacting: () => {
          this.compacting = true;
          this.status?.phase(COMPACTING);
        },
        compacted: (result) => {
          this.compacting = false;
          this.turnCompactions.push(result);
          this.status?.phase(null);
        },
        recoverCapacity: (failure, retries, canRetry) => this.closed ? Promise.resolve(false) : this.capacity.recover(
          failure, retries, canRetry && this.turnInputVersion === this.inputVersion,
        ),
      },
    });
  }

  /** The running SDK query, if the child is up — for control-channel questions. */
  get live(): Query | null {
    return this.agent.controlQuery;
  }

  get effort(): Effort {
    return this.effortLevel;
  }

  get model(): Model {
    return this.modelId;
  }

  /**
   * Change the reasoning effort for this topic. It is recorded against the
   * topic, so a session that is restarted later comes back on the same level,
   * and it lands on the agent from the next turn on — a turn already running
   * finishes on the level it started with.
   */
  setEffort(level: Effort): void {
    this.effortLevel = level;
    setEffort(this.threadId, level);
    if (this.provider === "openrouter") {
      const base = this.openrouterSettings ?? { model: this.modelId };
      const reasoning =
        level === null
          ? undefined
          : base.reasoning && typeof base.reasoning === "object" && !Array.isArray(base.reasoning)
            ? { ...(base.reasoning as Record<string, unknown>), effort: level }
            : { effort: level };
      this.openrouterSettings = {
        ...base,
        preset: null,
        ...(reasoning === undefined ? {} : { reasoning }),
        ...(reasoning === undefined ? { reasoning: undefined } : {}),
      };
      setOpenRouterSettings(this.threadId, this.openrouterSettings);
    }
    if (this.turnActive) {
      this.settingsDirty = true;
      return;
    }
    void this.applySettings();
  }

  /**
   * Change the model for this topic — the same contract as `setEffort`: it is
   * recorded against the topic, and a turn already running finishes on the
   * model it started with.
   */
  setModel(model: Model): void {
    this.modelId = model;
    if (this.provider === "openrouter") {
      this.openrouterSettings = model ? { model, preset: null } : { model: null };
      setOpenRouterSettings(this.threadId, this.openrouterSettings);
    }
    setModel(this.threadId, model);
    if (this.turnActive) {
      this.settingsDirty = true;
      return;
    }
    void this.applySettings();
  }

  /** Apply a complete preset at once, without exposing an intermediate state. */
  setSettings(settings: ModelSettings): void {
    const next = cloneSettings(settings);
    this.modelId = next.model;
    this.effortLevel = next.effort;
    this.serviceTier = next.serviceTier;
    this.openrouterSettings = next.openrouter;
    setModelSettings(this.threadId, next);
    if (this.turnActive) {
      this.settingsDirty = true;
      return;
    }
    void this.applySettings();
  }

  private get settings(): ModelSettings {
    return {
      model: this.modelId,
      effort: this.effortLevel,
      serviceTier: this.serviceTier,
      openrouter: this.openrouterSettings,
    };
  }

  private async applySettings(): Promise<void> {
    this.settingsDirty = false;
    await this.agent.applySettings({ sessionId: this.sessionId, ...this.settings });
  }

  /**
   * Hand a user message to the agent — now if it's idle, at its next step if
   * not. `content` is plain text, or the block list a message with images needs.
   */
  async send(content: AgentInput): Promise<void> {
    touch(this.threadId);
    this.armIdleTimer();
    if (content.replyTo && await this.agent.answerQuestion?.(content.replyTo.messageId, content)) {
      if (this.capacity.pending || this.quota.pending) {
        this.inputVersion++;
        this.capacity.clear("Superseded by an answer to a native question.");
        this.quota.clear("Superseded by an answer to a native question.");
      }
      return;
    }
    this.inputVersion++;
    this.capacity.clear("Superseded by a new message.");
    this.quota.clear("Superseded by a new message.");
    const progress = getTopic(this.threadId)?.progress ?? "off";
    await this.agent.send({ ...content, text: `${progressInstruction(progress)}\n\n${replyContext(content)}` });
  }

  /**
   * Ask a provider-native side question. Its renderer is scoped to
   * the invoking Telegram message, so answer and status form one direct reply
   * without sharing the main turn's output buffer or status line.
   */
  async btw(content: AgentInput, replyToMessageId: number): Promise<void> {
    touch(this.threadId);
    this.sideTurns++;
    this.armIdleTimer();

    const out = new TopicRenderer(this.bot.api, cfg.chatId, this.threadId, {
      replyToMessageId,
    });
    const status = new TurnStatus(out);
    const effort = this.effortLevel ?? defaultEffort(this.cwd, this.provider);
    const model = modelLabel(
      this.modelId ?? defaultModel(this.provider),
      undefined,
      this.provider,
    );
    const preset = presetName(this.provider, this.settings);
    await status.start();

    try {
      const result = await this.agent.btw(content, (name) => status.tool(name));
      // Codex and OpenRouter report side-turn usage. Claude's side_question
      // control response currently does not, so don't invent tokens or a turn.
      if (this.provider === "codex" || this.provider === "openrouter") {
        addUsage(this.threadId, result.usage);
      }
      const summary = summarize(
        result.ok && !result.failure,
        status,
        result.usage,
        effort,
        this.provider === "openrouter" && result.resolvedModel
          ? result.resolvedModel
          : model,
        this.provider === "codex" ? this.serviceTier : null,
        result.stopped,
        [],
        this.provider,
        this.provider === "openrouter" ? null : preset,
      );
      const answer = [result.answer, result.failure].filter(Boolean).join("\n\n");
      await status.finishWithAnswer(answer, summary);
    } catch (err) {
      console.error(`[btw:${this.threadId}] side turn failed:`, err);
      await status.finishWithAnswer(`❌ ${String(err)}`, `⚠️ ${compactMs(status.elapsedMs)}`);
    } finally {
      this.sideTurns--;
      if (!this.closed) this.armIdleTimer();
    }
  }

  /**
   * Compact the session's context as a turn of its own, with the usual status
   * line and summary. Returns a note for the user when it can't start, or when
   * it starts with a caveat; null when it simply started.
   */
  async compact(instructions: string): Promise<string | null> {
    if (!this.agent.compact) return "⚠️ /compact isn't available for this provider.";
    if (!this.sessionId) return "⚠️ Nothing to compact yet — send a message first.";
    if (this.turnActive) return "⚠️ A turn is running. Wait for it to finish, or /stop it first.";
    touch(this.threadId);
    this.armIdleTimer();
    this.compactRequested = true;
    const started = await this.agent.compact(instructions);
    this.compactRequested = false;
    if (!started) return "⚠️ A turn is running. Wait for it to finish, or /stop it first.";
    return instructions && this.provider === "codex"
      ? "Codex compaction takes no instructions; compacting without them." : null;
  }

  /**
   * Abort only the running turn. Input already queued for later is preserved.
   * Returns false when there was nothing to interrupt.
   */
  async interrupt(): Promise<boolean> {
    const quotaWaiting = this.quota.clear("Automatic quota recovery stopped.");
    const waiting = this.capacity.clear("Retries stopped.") || quotaWaiting;
    if (waiting) {
      await this.agent.interrupt();
      return true;
    }
    if (!this.turnActive) return this.agent.interrupt();
    denyPending(this.threadId, "stopped");
    return this.agent.interrupt();
  }

  async retryCapacity(): Promise<boolean> {
    if (this.closed) return false;
    if (this.capacity.retryNow()) return true;
    return await this.agent.retryCapacity?.() ?? false;
  }

  /** Shut the live runner down. The provider session id survives for resume. */
  close(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.closed = true;
    this.capacity.clear("Session closed. Automatic retries cancelled.");
    this.quota.clear("Session closed. Automatic quota recovery cancelled.");
    // Blanket approvals are scoped to the live session, not to the topic.
    clearPermissions(this.threadId);
    this.agent.close();
  }

  private armIdleTimer(rearm = false): void {
    if (this.closed) return;
    if (!rearm) this.idleSince = Date.now();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      // Never pull the rug out from under a running turn.
      if (this.turnActive || this.sideTurns > 0 || this.capacity.pending || this.quota.pending) return this.armIdleTimer(true);
      // A background shell or monitor reports back by starting a turn, and that
      // turn needs a live session to answer through. Wait for it, within limits.
      const tasks = this.agent.backgroundTasks ?? 0;
      if (tasks && Date.now() - this.idleSince < BACKGROUND_HOLD_MS) return this.armIdleTimer(true);
      console.log(
        `[session] closing idle session for topic ${this.threadId}` +
          (tasks ? ` (${tasks} background task(s) still running)` : ""),
      );
      forget(this.threadId);
      this.close();
    }, cfg.sessionIdleMs);
  }

  /** Idempotent: the first sign of a turn opens the status line, whoever spots it. */
  private async beginTurn(): Promise<void> {
    if (this.turnActive) return;
    this.turnActive = true;
    this.turnInputVersion = this.inputVersion;
    this.turnEffort = this.effortLevel;
    this.turnModel = this.modelId;
    this.turnResolvedModel = null;
    this.turnServiceTier = this.serviceTier;
    this.turnWeeklyBaseline = null;
    this.turnClaudeBaselineUsd = null;
    this.turnClaudeRatio = null;
    this.turnCompact = this.compactRequested;
    this.compactRequested = false;
    this.compacting = false;
    this.turnCompactions = [];
    if (this.provider === "claude") {
      this.turnClaudeRatio = claudeWeeklyRatio();
      this.turnClaudeBaselineUsd = this.sessionId ? claudeSessionUsd(this.sessionId) : 0;
    }
    this.out.clear();
    this.status = new TurnStatus(this.out, this.statusDetail());
    if (this.turnCompact) this.status.phase(COMPACTING);
    await this.status.start();
    if (this.provider === "codex") {
      // runStreamed starts only after this hook resolves, so this snapshot
      // cannot accidentally include any response from the new turn.
      this.turnWeeklyBaseline = this.sessionId
        ? await codexWeeklyPercent(this.sessionId, this.turnServiceTier)
        : 0;
    }
  }

  private async endTurn(result: AgentTurnResult): Promise<void> {
    const status = this.status;
    // Nothing picked means the turn ran on the provider's resolved default — a
    // real level/model, so each goes in the summary rather than as an absence.
    const effort = this.turnEffort ?? defaultEffort(this.cwd, this.provider);
    this.turnResolvedModel = result.resolvedModel ?? this.turnResolvedModel;
    const model = modelLabel(
      this.provider === "openrouter"
        ? this.turnResolvedModel ?? this.turnModel ?? defaultModel(this.provider)
        : this.turnModel ?? defaultModel(this.provider),
      undefined,
      this.provider,
    );
    const preset =
      this.provider !== "openrouter"
        ? presetName(this.provider, {
            model: this.turnModel,
            effort: this.turnEffort,
            serviceTier: this.turnServiceTier,
            openrouter: null,
          })
        : null;
    this.status = null;
    this.turnActive = false;
    const compactTurn = this.turnCompact;
    // A compaction the turn never finished failed with it.
    if (this.compacting) this.turnCompactions.push({ ok: false, preTokens: null, postTokens: null });
    this.compacting = false;
    const compactions = this.turnCompactions.map(compactionPart);
    if (compactTurn && !compactions.length) compactions.push(result.ok ? "🗜 compacted" : "🗜 failed");

    const quotaFailure = !compactTurn && !result.ok && !result.stopped && !this.closed && this.provider !== "openrouter"
      && this.turnInputVersion === this.inputVersion && isQuotaFailure(result.failure);
    // The agent stayed silent — fall back to whatever text the turn produced,
    // rather than leaving the topic with nothing but a summary. A compaction
    // turn has no answer; its text is the CLI's own command output.
    if (result.sent === 0 && !quotaFailure && !compactTurn) await this.out.send();
    else this.out.clear();
    if (quotaFailure) await this.quota.offer(result.failure!, result.quotaResetsAt);
    else {
      this.quota.clear(result.ok ? "Task resumed." : "Turn ended.");
      if (result.failure && !result.recoveringCapacity) await this.out.sendText(result.failure);
    }
    if (!result.recoveringCapacity) this.capacity.clear(result.ok ? "Recovered." : "Turn ended.");

    addUsage(this.threadId, result.usage);
    if (this.sessionId) setSession(this.threadId, this.sessionId);
    const extra = [...compactions, ...(
      this.provider === "codex"
        ? await codexSummaryParts(this.sessionId, this.turnWeeklyBaseline, this.turnServiceTier)
        : this.provider === "claude"
          ? [this.claudeWeeklyPart()].filter((p): p is string => p !== null)
          : [])];
    await status?.finish(
      summarize(
        result.ok && !result.failure,
        status,
        result.usage,
        effort,
        model,
        this.provider === "codex" ? this.turnServiceTier : null,
        result.stopped,
        extra,
        this.provider,
        preset,
      ),
    );
    if (this.provider === "claude") void sampleClaudeWeekly(this.live);
    await this.retitle();
    if (!this.closed) {
      this.armIdleTimer();
      if (this.settingsDirty) await this.applySettings();
    }
  }

  private statusDetail(): (() => Promise<string | null>) | undefined {
    if (this.provider === "codex") {
      return () => codexWeeklyPart(this.sessionId, this.turnWeeklyBaseline, this.turnServiceTier);
    }
    if (this.provider === "claude") return async () => this.claudeWeeklyPart();
    if (this.provider === "openrouter") {
      return async () => (this.turnResolvedModel ? `🤖 ${this.turnResolvedModel}` : null);
    }
    return undefined;
  }

  private claudeWeeklyPart(): string | null {
    return claudeWeeklyPart(
      claudeSessionUsd(this.sessionId),
      this.turnClaudeBaselineUsd,
      this.turnClaudeRatio,
    );
  }

  /** Replace the provisional topic title once the provider can settle it. */
  private async retitle(): Promise<void> {
    if (!this.sessionId) return;
    const topic = getTopic(this.threadId);
    if (!topic || !isPendingTitle(topic.title)) return;
    try {
      const title = await this.agent.suggestTitle(topic.title);
      if (!title) return;
      await this.bot.api.editForumTopic(cfg.chatId, this.threadId, { name: title });
      setTitle(this.threadId, title);
    } catch (err) {
      console.warn(`[session] retitling topic ${this.threadId} failed:`, String(err));
    }
  }
}

/** `🗜 152.3k→18.1k` for one compaction; either size may be unknown. */
function compactionPart(result: CompactionResult): string {
  if (!result.ok) return "🗜 failed";
  const { preTokens: pre, postTokens: post } = result;
  if (pre !== null && post !== null) return `🗜 ${fmtTokens(pre)}→${fmtTokens(post)}`;
  if (post !== null) return `🗜 →${fmtTokens(post)}`;
  return "🗜 compacted";
}

/** The one line that replaces the live status when a turn ends. */
function summarize(
  ok: boolean,
  status: TurnStatus | null,
  usage: Usage,
  effort: string,
  model: string,
  serviceTier: ServiceTier,
  stopped = false,
  extra: string[] = [],
  provider: Provider = "claude",
  preset: string | null = null,
): string {
  const marker = stopped ? "⏹" : ok ? "✅" : "⚠️";
  const parts =
    provider === "codex"
      ? [
          `${marker} ${compactMs(status?.elapsedMs ?? 0)}`,
          preset ?? `${model}/${effort}${serviceTier === "fast" ? "/fast" : ""}`,
        ]
      : provider === "openrouter"
        ? [`${marker} ${humanMs(status?.elapsedMs ?? 0)}`, `🤖 ${model}`]
      : preset
        ? [marker, humanMs(status?.elapsedMs ?? 0), preset]
        : [marker, humanMs(status?.elapsedMs ?? 0), `🤖 ${model}`, `⚙️ ${effort}`];
  if (provider !== "codex" && serviceTier === "fast") {
    parts.push(`🚀 ${serviceTierLabel(serviceTier)}`);
  }
  if (status && status.toolCalls > 0) {
    parts.push(`🔧 ${status.toolCalls}`);
  }
  if (provider === "openrouter" && (usage.inTokens || usage.outTokens)) {
    parts.push(`${fmtTokens(usage.inTokens)}↑ ${fmtTokens(usage.outTokens)}↓`);
  }
  if (provider === "openrouter" && usage.costUsd !== null && usage.costUsd > 0) {
    parts.push(`$${usage.costUsd.toFixed(4)}`);
  }
  parts.push(...extra);
  return parts.join(" · ");
}

// ---- registry ------------------------------------------------------------

const live = new Map<number, TopicSession>();

/** The live session for a topic, started (or resumed) on demand. */
export function sessionFor(
  bot: Bot,
  topic: {
    thread_id: number;
    cwd: string;
    session_id: string | null;
    provider?: Provider;
    effort?: Effort;
    model?: Model;
    service_tier?: ServiceTier;
    openrouter_settings?: OpenRouterSettings | null;
  },
): TopicSession {
  const existing = live.get(topic.thread_id);
  if (existing) return existing;
  const s = new TopicSession(
    bot,
    topic.thread_id,
    topic.cwd,
    topic.session_id,
    topic.provider ?? "claude",
    topic.effort ?? null,
    topic.model ?? null,
    topic.service_tier ?? null,
    topic.openrouter_settings ?? null,
  );
  live.set(topic.thread_id, s);
  return s;
}

/** A topic's session only if it is already up — never starts one. */
export function liveSession(threadId: number): TopicSession | undefined {
  return live.get(threadId);
}

/** A global policy change also updates every currently waiting topic. */
export async function capacityRetrySettingsChanged(): Promise<void> {
  await Promise.all([...live.values()].map(session => session.capacity.settingsChanged()
    .catch(err => console.warn(`[capacity:${session.threadId}] refreshing settings failed:`, String(err)))));
}

/**
 * Any topic's running query — the account's rate limits are the same whichever
 * session asks, so `/usage` reuses a warm child instead of starting one.
 */
export function anyLiveQuery(): Query | null {
  for (const s of live.values()) if (s.live) return s.live;
  return null;
}

/** Drop the registry entry without touching the session itself. */
function forget(threadId: number): void {
  live.delete(threadId);
}

/** Shut a topic's session down — used when the topic is closed or deleted. */
export function endSession(threadId: number): void {
  const s = live.get(threadId);
  if (!s) return;
  live.delete(threadId);
  s.close();
}
