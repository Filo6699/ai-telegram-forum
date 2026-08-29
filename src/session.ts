import {
  getSessionInfo,
  query,
  type Query,
  type EffortLevel as ClaudeEffortLevel,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Thread as CodexThread } from "@openai/codex-sdk";
import type { Bot } from "grammy";
import { queryOptions, readUsage, type Usage } from "./claude.ts";
import {
  codexInput,
  codexToolName,
  createCodexThread,
  isCodexSend,
  readCodexUsage,
  type CodexInput,
} from "./codex.ts";
import { cfg } from "./config.ts";
import { isPendingTitle } from "./cwd.ts";
import { addUsage, getTopic, setEffort, setModel, setSession, setTitle, touch } from "./db.ts";
import { defaultEffort, effortLabel, type Effort } from "./effort.ts";
import { defaultModel, modelLabel, type Model } from "./model.ts";
import type { ImagePart } from "./media.ts";
import type { Provider } from "./provider.ts";
import { fmtTokens, humanMs } from "./fmt.ts";
import { clearPermissions, denyPending } from "./permission.ts";
import { TopicRenderer } from "./render.ts";
import { TurnStatus } from "./status.ts";
import { createTgChannel, TG_SEND_TOOL, type TgChannel } from "./tg-tools.ts";

const zeroUsage = (): Usage => ({ inTokens: 0, outTokens: 0, costUsd: 0 });

export interface AgentInput {
  text: string;
  images: ImagePart[];
}

function claudeMessage(input: AgentInput): SDKUserMessage {
  const content: SDKUserMessage["message"]["content"] = input.images.length
    ? [
        ...input.images.map((image) => ({
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: image.mediaType as "image/jpeg",
            data: image.data,
          },
        })),
        ...(input.text ? [{ type: "text" as const, text: input.text }] : []),
      ]
    : input.text;
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
  };
}

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
  private channel: TgChannel;

  // Input side: messages waiting to be pulled by the iterator.
  private pending: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private ended = false;

  private q: Query | null = null;
  private codexThread: CodexThread | null = null;
  private codexPending: CodexInput[] = [];
  private codexAbort: AbortController | null = null;
  private codexSent = 0;
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
    readonly provider: Provider = "claude",
    private effortLevel: Effort = null,
    private modelId: Model = null,
  ) {
    this.out = new TopicRenderer(bot.api, cfg.chatId, threadId);
    this.channel = createTgChannel(this.out, cwd);
  }

  /** The running SDK query, if the child is up — for control-channel questions. */
  get live(): Query | null {
    return this.provider === "claude" ? this.q : null;
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
    if (this.provider === "codex") {
      if (this.turnActive) this.effortDirty = true;
      else this.resetCodexThread();
      return;
    }
    if (!this.q) return; // child is down: `run()` will pass it at startup
    if (this.turnActive) {
      this.effortDirty = true;
      return;
    }
    void this.pushEffort();
  }

  private async pushEffort(): Promise<void> {
    this.effortDirty = false;
    if (this.provider === "codex") {
      this.resetCodexThread();
      return;
    }
    // null clears our layer, dropping back to whatever Claude defaults to.
    try {
      await this.q?.applyFlagSettings({
        effortLevel: this.effortLevel as ClaudeEffortLevel | null,
      });
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
    if (this.provider === "codex") {
      if (this.turnActive) this.modelDirty = true;
      else this.resetCodexThread();
      return;
    }
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
      await this.q?.setModel(this.modelId ?? defaultModel("claude"));
    } catch (err) {
      console.warn(
        `[model] applying ${modelLabel(this.modelId, undefined, this.provider)} ` +
          `to topic ${this.threadId} failed:`,
        String(err),
      );
    }
  }

  /**
   * Hand a user message to the agent — now if it's idle, at its next step if
   * not. `content` is plain text, or the block list a message with images needs.
   */
  async send(content: AgentInput): Promise<void> {
    touch(this.threadId);
    this.armIdleTimer();
    if (this.provider === "codex") this.codexPending.push(content);
    else this.push(claudeMessage(content));
    if (!this.running) void this.run();
    if (this.provider === "claude") await this.beginTurn();
  }

  /**
   * Abort the running turn without ending the session — the child stays up and
   * the next message continues the same conversation. Messages that arrived
   * while the turn ran are dropped: stop means stop. Returns false when there
   * was nothing to interrupt.
   */
  async interrupt(): Promise<boolean> {
    if (!this.turnActive) return false;
    this.stopped = true;
    this.pending = [];
    this.codexPending = [];
    denyPending(this.threadId, "stopped");
    if (this.provider === "codex") this.codexAbort?.abort();
    else {
      if (!this.q) return false;
      await this.q.interrupt();
    }
    return true;
  }

  /** Shut the live runner down. The provider session id survives for resume. */
  close(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    // Blanket approvals are scoped to the live session, not to the topic.
    clearPermissions(this.threadId);
    this.ended = true;
    this.codexPending = [];
    this.codexAbort?.abort();
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
    this.codexSent = 0;
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
    this.failure = null;
    this.stopped = false;

    // The agent stayed silent — fall back to whatever text the turn produced,
    // rather than leaving the topic with nothing but a summary.
    const sent = this.provider === "codex" ? this.codexSent : this.channel.sent;
    if (sent === 0) await this.out.send();
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
    if (this.provider === "codex") {
      // Codex does not currently expose generated session titles through the
      // TypeScript SDK. The prompt-derived name is already useful; remove the
      // provisional marker once the first turn is safely persisted.
      const title = topic.title.slice(2);
      try {
        await this.bot.api.editForumTopic(cfg.chatId, this.threadId, { name: title });
        setTitle(this.threadId, title);
      } catch (err) {
        console.warn(`[session] retitling topic ${this.threadId} failed:`, String(err));
      }
      return;
    }
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

  private resetCodexThread(): void {
    if (this.provider !== "codex") return;
    this.codexThread = createCodexThread({
      threadId: this.threadId,
      cwd: this.cwd,
      sessionId: this.sessionId,
      effort: this.effortLevel,
      model: this.modelId,
    });
  }

  private async run(): Promise<void> {
    if (this.provider === "codex") await this.runCodex();
    else await this.runClaude();
  }

  private async runClaude(): Promise<void> {
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

  private async runCodex(): Promise<void> {
    this.running = true;
    this.ended = false;
    if (!this.codexThread) this.resetCodexThread();

    try {
      while (!this.ended && this.codexPending.length) {
        const batch = this.codexPending.splice(0);
        const input: CodexInput = {
          text: batch.map((message) => message.text).filter(Boolean).join("\n\n"),
          images: batch.flatMap((message) => message.images),
        };
        this.codexAbort = new AbortController();
        await this.beginTurn();
        const streamed = await this.codexThread!.runStreamed(codexInput(input), {
          signal: this.codexAbort.signal,
        });
        let terminal = false;

        for await (const event of streamed.events) {
          switch (event.type) {
            case "thread.started":
              this.sessionId = event.thread_id;
              break;

            case "item.started": {
              const name = codexToolName(event.item);
              if (name) this.status?.tool(name);
              break;
            }

            case "item.completed":
              if (event.item.type === "agent_message" && event.item.text.trim()) {
                this.out.hold(event.item.text);
              } else if (
                isCodexSend(event.item) &&
                event.item.type === "mcp_tool_call" &&
                event.item.status === "completed"
              ) {
                this.codexSent++;
              } else if (event.item.type === "error" && !this.failure) {
                this.failure = `⚠️ ${event.item.message}`;
              }
              break;

            case "turn.completed":
              this.usage = readCodexUsage(event.usage);
              terminal = true;
              await this.endTurn(true);
              break;

            case "turn.failed":
              if (!this.stopped) this.failure = `⚠️ ${event.error.message}`;
              terminal = true;
              await this.endTurn(false);
              break;

            case "error":
              if (!this.stopped) this.failure = `⚠️ ${event.message}`;
              break;
          }
        }

        if (!terminal && this.turnActive) {
          if (!this.stopped) this.failure = this.failure ?? "⚠️ Codex ended without a turn result";
          await this.endTurn(false);
        }
        this.codexAbort = null;
      }
    } catch (err) {
      if (!this.stopped) {
        this.failure = `❌ ${String(err)}`;
        console.error(`[codex:${this.threadId}] session died:`, err);
      }
      if (this.turnActive) await this.endTurn(false);
    } finally {
      this.running = false;
      this.codexAbort = null;
      this.ended = false;
      clearPermissions(this.threadId);
      // A message can land between the loop deciding the queue is empty and
      // `running` flipping back. Start it now instead of waiting for a third.
      if (this.codexPending.length) void this.runCodex();
      else this.armIdleTimer();
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
    provider?: Provider;
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
    topic.provider ?? "claude",
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
