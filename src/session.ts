import {
  getSessionInfo,
  query,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Bot } from "grammy";
import { queryOptions, readUsage, type Usage } from "./claude.ts";
import { cfg } from "./config.ts";
import { isPendingTitle } from "./cwd.ts";
import { addUsage, getTopic, setEffort, setModel, setSession, setTitle, touch } from "./db.ts";
import { defaultEffort, effortLabel, type Effort } from "./effort.ts";
import { defaultModel, modelLabel, type Model } from "./model.ts";
import { fmtTokens, humanMs } from "./fmt.ts";
import { clearPermissions, denyPending } from "./permission.ts";
import { TopicRenderer } from "./render.ts";
import { TurnStatus } from "./status.ts";
import { createTgChannel, TG_SEND_TOOL, type TgChannel } from "./tg-tools.ts";

const zeroUsage = (): Usage => ({ inTokens: 0, outTokens: 0, costUsd: 0 });

/**
 * One live Agent SDK session per topic.
 *
 * The session is fed by an async iterator that stays open between turns, so a
 * message that arrives while the agent is working is handed to it at its next
 * step instead of waiting for the turn to end. Nothing is interrupted: the
 * running tool finishes, then the agent sees the new message alongside its
 * result.
 *
 * The child process is kept only while the topic is warm — after
 * `SESSION_IDLE_MINUTES` of silence it is shut down, and the next message
 * starts a fresh one resuming the same Claude session id.
 */
export class TopicSession {
  private out: TopicRenderer;
  private channel: TgChannel;

  // Input side: messages waiting to be pulled by the iterator.
  private pending: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private ended = false;

  private q: Query | null = null;
  private running = false;

  // An effort or model change asked for mid-turn: applied once the turn is
  // over, so a running turn keeps what it started on.
  private effortDirty = false;
  private modelDirty = false;

  // Per-turn state.
  private status: TurnStatus | null = null;
  private turnActive = false;
  private turnEffort: Effort = null;
  private turnModel: Model = null;
  private usage = zeroUsage();
  private failure: string | null = null;
  private stopped = false;
  private stderr = "";

  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private bot: Bot,
    readonly threadId: number,
    private cwd: string,
    private sessionId: string | null,
    private effortLevel: Effort = null,
    private modelId: Model = null,
  ) {
    this.out = new TopicRenderer(bot.api, cfg.chatId, threadId);
    this.channel = createTgChannel(this.out, cwd);
  }

  /** The running SDK query, if the child is up — for control-channel questions. */
  get live(): Query | null {
    return this.q;
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
    if (!this.q) return; // child is down: `run()` will pass it at startup
    if (this.turnActive) {
      this.effortDirty = true;
      return;
    }
    void this.pushEffort();
  }

  private async pushEffort(): Promise<void> {
    this.effortDirty = false;
    // null clears our layer, dropping back to whatever Claude defaults to.
    try {
      await this.q?.applyFlagSettings({ effortLevel: this.effortLevel });
    } catch (err) {
      console.warn(
        `[effort] applying ${effortLabel(this.effortLevel)} to topic ${this.threadId} failed:`,
        String(err),
      );
    }
  }

  /**
   * Change the model for this topic — the same contract as `setEffort`: it is
   * recorded against the topic, and a turn already running finishes on the
   * model it started with.
   */
  setModel(model: Model): void {
    this.modelId = model;
    setModel(this.threadId, model);
    if (!this.q) return; // child is down: `run()` will pass it at startup
    if (this.turnActive) {
      this.modelDirty = true;
      return;
    }
    void this.pushModel();
  }

  private async pushModel(): Promise<void> {
    this.modelDirty = false;
    // Nothing picked means the configured MODEL, which is what the child was
    // started on — say so explicitly rather than leaving the last pick in place.
    try {
      await this.q?.setModel(this.modelId ?? defaultModel());
    } catch (err) {
      console.warn(
        `[model] applying ${modelLabel(this.modelId)} to topic ${this.threadId} failed:`,
        String(err),
      );
    }
  }

  /**
   * Hand a user message to the agent — now if it's idle, at its next step if
   * not. `content` is plain text, or the block list a message with images needs.
   */
  async send(content: SDKUserMessage["message"]["content"]): Promise<void> {
    touch(this.threadId);
    this.armIdleTimer();
    this.push({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
    });
    if (!this.running) void this.run();
    await this.beginTurn();
  }

  /**
   * Abort the running turn without ending the session — the child stays up and
   * the next message continues the same conversation. Messages that arrived
   * while the turn ran are dropped: stop means stop. Returns false when there
   * was nothing to interrupt.
   */
  async interrupt(): Promise<boolean> {
    if (!this.q || !this.turnActive) return false;
    this.stopped = true;
    this.pending = [];
    denyPending(this.threadId, "stopped");
    await this.q.interrupt();
    return true;
  }

  /** Shut the child down. The Claude session id survives in the DB for resume. */
  close(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    // Blanket approvals are scoped to the live session, not to the topic.
    clearPermissions(this.threadId);
    this.ended = true;
    this.wake?.();
    this.wake = null;
  }

  private push(msg: SDKUserMessage): void {
    this.pending.push(msg);
    this.wake?.();
    this.wake = null;
  }

  private async *input(): AsyncGenerator<SDKUserMessage> {
    while (!this.ended) {
      if (!this.pending.length) await new Promise<void>((r) => (this.wake = r));
      while (this.pending.length) yield this.pending.shift()!;
    }
  }

  private armIdleTimer(): void {
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
    this.usage = zeroUsage();
    this.failure = null;
    this.stopped = false;
    this.stderr = "";
    this.channel.resetSent();
    this.out.clear();
    this.status = new TurnStatus(this.out);
    await this.status.start();
  }

  private async endTurn(ok: boolean): Promise<void> {
    const status = this.status;
    const failure = this.failure;
    const usage = this.usage;
    const stopped = this.stopped;
    // Nothing picked means the turn ran on the level Claude resolves for this
    // cwd — a real level, so it goes in the summary like any other. Same for
    // the model: unset is the configured MODEL, not an absence.
    const effort = this.turnEffort ?? defaultEffort(this.cwd);
    const model = modelLabel(this.turnModel ?? defaultModel());
    this.status = null;
    this.turnActive = false;
    this.failure = null;
    this.stopped = false;

    // The agent stayed silent — fall back to whatever text the turn produced,
    // rather than leaving the topic with nothing but a summary.
    if (this.channel.sent === 0) await this.out.send();
    else this.out.clear();
    if (failure) await this.out.sendText(failure);

    addUsage(this.threadId, usage);
    if (this.sessionId) setSession(this.threadId, this.sessionId);
    await status?.finish(summarize(ok && !failure, status, usage, effort, model, stopped));
    await this.retitle();
    this.armIdleTimer();
    // The turn is over — changes that arrived while it ran can land now.
    if (this.effortDirty) await this.pushEffort();
    if (this.modelDirty) await this.pushModel();
  }

  /**
   * Swap the launch placeholder for the title Claude generated for the session.
   * It only exists once the first turn is on disk, so this is tried after every
   * turn until it lands.
   */
  private async retitle(): Promise<void> {
    if (!this.sessionId) return;
    const topic = getTopic(this.threadId);
    if (!topic || !isPendingTitle(topic.title)) return;
    try {
      const info = await getSessionInfo(this.sessionId);
      const name = info?.summary?.trim();
      // Until a title is generated, `summary` is just the first prompt back.
      if (!name || name === info?.firstPrompt?.trim()) return;
      const title = name.slice(0, 128);
      await this.bot.api.editForumTopic(cfg.chatId, this.threadId, { name: title });
      setTitle(this.threadId, title);
    } catch (err) {
      console.warn(`[session] retitling topic ${this.threadId} failed:`, String(err));
    }
  }

  private async run(): Promise<void> {
    this.running = true;
    this.ended = false;
    try {
      this.q = query({
        prompt: this.input(),
        options: queryOptions({
          bot: this.bot,
          threadId: this.threadId,
          cwd: this.cwd,
          resume: this.sessionId,
          effort: this.effortLevel,
          model: this.modelId,
          channel: this.channel,
          onStderr: (data) => {
            this.stderr += data;
            console.error(`[claude:${this.threadId}] ${data.trimEnd()}`);
          },
        }),
      });

      for await (const msg of this.q) {
        switch (msg.type) {
          case "system":
            if (msg.subtype === "init") this.sessionId = msg.session_id;
            break;

          case "assistant": {
            await this.beginTurn();
            const said: string[] = [];
            for (const block of msg.message.content) {
              if (block.type === "text") said.push(block.text);
              // Posting the reply is a tool call like any other, but it isn't
              // work the user asked for — keep it out of the count.
              else if (block.type === "tool_use" && block.name !== TG_SEND_TOOL) {
                this.status?.tool(block.name);
              }
            }
            // Hold the newest reply, replacing the last one — and only the main
            // agent's. What it writes between tool calls is thinking out loud,
            // and a subagent's text was never addressed to the topic; posting
            // the lot as the fallback is how a quiet turn ended up dumping a
            // wall of step-by-step narration.
            const text = said.join("");
            if (text.trim() && !msg.parent_tool_use_id) this.out.hold(text);
            break;
          }

          case "result": {
            this.sessionId = msg.session_id;
            const ok = msg.subtype === "success";
            this.usage = readUsage(msg);
            // Last-resort text: if no assistant message carried the reply, the
            // result still holds it in full.
            if (ok && this.out.isEmpty) {
              const text = (msg as any).result;
              if (typeof text === "string") this.out.hold(text);
            }
            if (!ok && !this.stopped) {
              this.failure = `⚠️ ${msg.subtype}: ${(msg as any).error ?? ""}`;
            }
            await this.endTurn(ok);
            break;
          }
        }
      }
    } catch (err) {
      const detail = this.stderr.trim().split("\n").filter(Boolean).slice(-5).join("\n");
      this.failure = `❌ ${String(err)}` + (detail ? `\n\n\`\`\`\n${detail}\n\`\`\`` : "");
      console.error(`[session] topic ${this.threadId} died:`, err);
      await this.endTurn(false);
    } finally {
      this.running = false;
      this.q = null;
      this.ended = false;
      // Nothing can act on an approval once the child is gone.
      clearPermissions(this.threadId);
      // A crash loses whatever the iterator hadn't handed over yet. Say so
      // instead of leaving the sender waiting on a reply that won't come.
      if (this.pending.length) {
        const lost = this.pending.length;
        this.pending = [];
        await this.out.sendText(`⚠️ ${lost} message(s) dropped when the session ended — resend them.`);
      }
      // The child is gone; the next message resumes from `sessionId`.
      forget(this.threadId);
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
  stopped = false,
): string {
  const parts = [
    stopped ? "⏹" : ok ? "✅" : "⚠️",
    humanMs(status?.elapsedMs ?? 0),
    `🤖 ${model}`,
    `⚙️ ${effort}`,
  ];
  if (status && status.toolCalls > 0) parts.push(`🔧 ${status.toolCalls}`);
  if (usage.inTokens || usage.outTokens) {
    parts.push(`${fmtTokens(usage.inTokens)}↑ ${fmtTokens(usage.outTokens)}↓`);
  }
  if (usage.costUsd > 0) parts.push(`$${usage.costUsd.toFixed(4)}`);
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
    effort?: Effort;
    model?: Model;
  },
): TopicSession {
  const existing = live.get(topic.thread_id);
  if (existing) return existing;
  const s = new TopicSession(
    bot,
    topic.thread_id,
    topic.cwd,
    topic.session_id,
    topic.effort ?? null,
    topic.model ?? null,
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
