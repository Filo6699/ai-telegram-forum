import type { Query } from "@anthropic-ai/claude-agent-sdk";
import type { Bot } from "grammy";
import type { Usage } from "./claude.ts";
import {
  createAgentSession,
  type AgentInput,
  type AgentSession,
  type AgentTurnResult,
} from "./agent-session.ts";
import { cfg } from "./config.ts";
import { codexSummaryParts } from "./codex-summary.ts";
import { isPendingTitle } from "./cwd.ts";
import { addUsage, getTopic, setEffort, setModel, setSession, setTitle, touch } from "./db.ts";
import { defaultEffort, effortLabel, type Effort } from "./effort.ts";
import { defaultModel, modelLabel, type Model } from "./model.ts";
import { serviceTierLabel, type ServiceTier } from "./preset-config.ts";
import type { Provider } from "./provider.ts";
import { fmtTokens, humanMs } from "./fmt.ts";
import { clearPermissions, denyPending } from "./permission.ts";
import { TopicRenderer } from "./render.ts";
import { TurnStatus } from "./status.ts";
import { createTgChannel } from "./tg-tools.ts";

export type { AgentInput } from "./agent-session.ts";

/**
 * One live Agent SDK session per topic.
 *
 * Claude is fed by an async iterator that stays open between turns, so a new
 * message reaches it at its next step. Codex's SDK has no steering API; those
 * messages are retained here and become its next native turn.
 *
 * The child process is kept only while the topic is warm — after
 * `SESSION_IDLE_MINUTES` of silence it is shut down, and the next message
 * starts a fresh one resuming the same provider session id.
 */
export class TopicSession {
  private out: TopicRenderer;
  private agent: AgentSession;

  // A settings change asked for mid-turn lands once that turn is over.
  private settingsDirty = false;

  // Per-turn state.
  private status: TurnStatus | null = null;
  private turnActive = false;
  private turnEffort: Effort = null;
  private turnModel: Model = null;
  private turnServiceTier: ServiceTier = null;
  private closed = false;

  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private bot: Bot,
    readonly threadId: number,
    private cwd: string,
    private sessionId: string | null,
    readonly provider: Provider = "claude",
    private effortLevel: Effort = null,
    private modelId: Model = null,
    private serviceTier: ServiceTier = null,
  ) {
    this.out = new TopicRenderer(bot.api, cfg.chatId, threadId);
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
      channel,
      hooks: {
        beginTurn: () => this.beginTurn(),
        session: (id) => {
          this.sessionId = id;
        },
        text: (value) => this.out.hold(value),
        tool: (name) => this.status?.tool(name),
        endTurn: (result) => this.endTurn(result),
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
    setModel(this.threadId, model);
    if (this.turnActive) {
      this.settingsDirty = true;
      return;
    }
    void this.applySettings();
  }

  private async applySettings(): Promise<void> {
    this.settingsDirty = false;
    await this.agent.applySettings({
      sessionId: this.sessionId,
      effort: this.effortLevel,
      model: this.modelId,
      serviceTier: this.serviceTier,
    });
  }

  /**
   * Hand a user message to the agent — now if it's idle, at its next step if
   * not. `content` is plain text, or the block list a message with images needs.
   */
  async send(content: AgentInput): Promise<void> {
    touch(this.threadId);
    this.armIdleTimer();
    await this.agent.send(content);
  }

  /**
   * Abort only the running turn. Input already queued for later is preserved.
   * Returns false when there was nothing to interrupt.
   */
  async interrupt(): Promise<boolean> {
    if (!this.turnActive) return false;
    denyPending(this.threadId, "stopped");
    return this.agent.interrupt();
  }

  /** Shut the live runner down. The provider session id survives for resume. */
  close(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.closed = true;
    // Blanket approvals are scoped to the live session, not to the topic.
    clearPermissions(this.threadId);
    this.agent.close();
  }

  private armIdleTimer(): void {
    if (this.closed) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      // Never pull the rug out from under a running turn.
      if (this.turnActive) return this.armIdleTimer();
      console.log(`[session] closing idle session for topic ${this.threadId}`);
      forget(this.threadId);
      this.close();
    }, cfg.sessionIdleMs);
  }

  /** Idempotent: the first sign of a turn opens the status line, whoever spots it. */
  private async beginTurn(): Promise<void> {
    if (this.turnActive) return;
    this.turnActive = true;
    this.turnEffort = this.effortLevel;
    this.turnModel = this.modelId;
    this.turnServiceTier = this.serviceTier;
    this.out.clear();
    this.status = new TurnStatus(this.out);
    await this.status.start();
  }

  private async endTurn(result: AgentTurnResult): Promise<void> {
    const status = this.status;
    // Nothing picked means the turn ran on the provider's resolved default — a
    // real level/model, so each goes in the summary rather than as an absence.
    const effort = this.turnEffort ?? defaultEffort(this.cwd, this.provider);
    const model = modelLabel(
      this.turnModel ?? defaultModel(this.provider),
      undefined,
      this.provider,
    );
    this.status = null;
    this.turnActive = false;

    // The agent stayed silent — fall back to whatever text the turn produced,
    // rather than leaving the topic with nothing but a summary.
    if (result.sent === 0) await this.out.send();
    else this.out.clear();
    if (result.failure) await this.out.sendText(result.failure);

    addUsage(this.threadId, result.usage);
    if (this.sessionId) setSession(this.threadId, this.sessionId);
    const topic = getTopic(this.threadId);
    const extra =
      this.provider === "codex"
        ? await codexSummaryParts(
            this.sessionId,
            (topic?.in_tokens ?? 0) + (topic?.out_tokens ?? 0),
          )
        : [];
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
      ),
    );
    await this.retitle();
    if (!this.closed) {
      this.armIdleTimer();
      if (this.settingsDirty) await this.applySettings();
    }
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
): string {
  const parts = [
    stopped ? "⏹" : ok ? "✅" : "⚠️",
    humanMs(status?.elapsedMs ?? 0),
    `🤖 ${model}`,
    `⚙️ ${effort}`,
  ];
  if (serviceTier === "fast") parts.push(`🚀 ${serviceTierLabel(serviceTier)}`);
  if (status && status.toolCalls > 0) parts.push(`🔧 ${status.toolCalls}`);
  if (provider !== "codex" && (usage.inTokens || usage.outTokens)) {
    parts.push(`${fmtTokens(usage.inTokens)}↑ ${fmtTokens(usage.outTokens)}↓`);
  }
  if (provider !== "codex" && usage.costUsd > 0) parts.push(`$${usage.costUsd.toFixed(4)}`);
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
  );
  live.set(topic.thread_id, s);
  return s;
}

/** A topic's session only if it is already up — never starts one. */
export function liveSession(threadId: number): TopicSession | undefined {
  return live.get(threadId);
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
