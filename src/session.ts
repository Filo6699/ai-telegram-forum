import { query, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Bot } from "grammy";
import { queryOptions, readUsage, type Usage } from "./claude.ts";
import { cfg } from "./config.ts";
import { addUsage, setSession, touch } from "./db.ts";
import { fmtTokens, humanMs } from "./fmt.ts";
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

  // Per-turn state.
  private status: TurnStatus | null = null;
  private turnActive = false;
  private usage = zeroUsage();
  private failure: string | null = null;
  private stderr = "";

  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    bot: Bot,
    readonly threadId: number,
    private cwd: string,
    private sessionId: string | null,
  ) {
    this.out = new TopicRenderer(bot, cfg.chatId, threadId);
    this.channel = createTgChannel(this.out);
  }

  /** Hand a user message to the agent — now if it's idle, at its next step if not. */
  async send(text: string): Promise<void> {
    touch(this.threadId);
    this.armIdleTimer();
    this.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    });
    if (!this.running) void this.run();
    await this.beginTurn();
  }

  /** Shut the child down. The Claude session id survives in the DB for resume. */
  close(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
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
    this.usage = zeroUsage();
    this.failure = null;
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
    this.status = null;
    this.turnActive = false;
    this.failure = null;

    // The agent stayed silent — fall back to whatever text the turn produced,
    // rather than leaving the topic with nothing but a summary.
    if (this.channel.sent === 0) await this.out.send();
    else this.out.clear();
    if (failure) await this.out.sendText(failure);

    addUsage(this.threadId, usage);
    if (this.sessionId) setSession(this.threadId, this.sessionId);
    await status?.finish(summarize(ok && !failure, status, usage));
    this.armIdleTimer();
  }

  private async run(): Promise<void> {
    this.running = true;
    this.ended = false;
    try {
      this.q = query({
        prompt: this.input(),
        options: queryOptions({
          cwd: this.cwd,
          resume: this.sessionId,
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
            for (const block of msg.message.content) {
              if (block.type === "text") this.out.push(block.text);
              // Posting the reply is a tool call like any other, but it isn't
              // work the user asked for — keep it out of the count.
              else if (block.type === "tool_use" && block.name !== TG_SEND_TOOL) {
                this.status?.tool(block.name);
              }
            }
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
              if (typeof text === "string") this.out.push(text);
            }
            if (!ok) this.failure = `⚠️ ${msg.subtype}: ${(msg as any).error ?? ""}`;
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
function summarize(ok: boolean, status: TurnStatus | null, usage: Usage): string {
  const parts = [ok ? "✅" : "⚠️", humanMs(status?.elapsedMs ?? 0)];
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
  topic: { thread_id: number; cwd: string; session_id: string | null },
): TopicSession {
  const existing = live.get(topic.thread_id);
  if (existing) return existing;
  const s = new TopicSession(bot, topic.thread_id, topic.cwd, topic.session_id);
  live.set(topic.thread_id, s);
  return s;
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
