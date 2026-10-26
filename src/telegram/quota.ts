import { InlineKeyboard, type Bot } from "grammy";
import { cfg } from "../config/env.ts";
import type { PlanLimits } from "../sessions/limits.ts";
import { quotaStatus } from "../sessions/quota-retry.ts";
import { getTopic } from "../storage/db.ts";
import { TopicRenderer } from "./render.ts";

export function registerQuotaButtons(
  bot: Bot,
  act: (threadId: number, action: "wait" | "stop", messageId: number) => Promise<void>,
): void {
  bot.on("callback_query:data", async (ctx, next) => {
    const match = /^quota:(\d+):(wait|stop)$/.exec(ctx.callbackQuery.data);
    if (!match) return next();
    const threadId = Number(match[1]);
    const message = ctx.callbackQuery.message;
    if (ctx.from.id !== cfg.allowedUserId || message?.chat.id !== cfg.chatId || message.message_thread_id !== threadId) {
      await ctx.answerCallbackQuery({ text: "Not authorized." }).catch(() => {});
      return;
    }
    const topic = getTopic(threadId);
    if (!topic || topic.status !== "active" || !["claude", "codex"].includes(topic.provider)) {
      await ctx.answerCallbackQuery({ text: "This session is closed." }).catch(() => {});
      return;
    }
    await ctx.answerCallbackQuery().catch(() => {});
    void Promise.resolve().then(() => act(threadId, match[2] as "wait" | "stop", message.message_id))
      .catch(err => console.warn("[quota] button failed:", String(err)));
  });
}

/** Opt-in recovery. Account reads are free; only a recovered/unknown quota starts a turn. */
export class QuotaRecovery {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private messageId: number | null = null;
  private enabled = false;
  private eligible = false;
  private failure = "";
  private state = "";
  private generation = 0;
  private checkId = 0;
  private resetHint: number | null = null;
  private edits: Promise<unknown> = Promise.resolve();

  constructor(
    private bot: Bot,
    private threadId: number,
    private out: TopicRenderer,
    private readLimits: () => Promise<PlanLimits | null>,
    private retry: () => Promise<boolean>,
    private model: () => string | null = () => null,
  ) {}

  get pending(): boolean { return this.enabled; }
  owns(messageId: number): boolean { return this.messageId === messageId; }

  async offer(failure: string, resetsAt: string | null = null): Promise<void> {
    this.cancelTimer();
    const generation = ++this.generation;
    this.failure = failure;
    const hint = Date.parse(resetsAt ?? "");
    this.resetHint = Number.isFinite(hint) ? hint : null;
    this.eligible = true;
    this.state = this.enabled ? "Waiting for subscription limits to recover. Checking every 20 minutes."
      : "Wait for subscription limits to recover, then continue this task automatically. Checks every 20 minutes and at the reported reset time.";
    await this.render();
    if (generation === this.generation && this.enabled) await this.check(false);
  }

  async start(messageId: number): Promise<void> {
    if (!this.owns(messageId) || !this.eligible || this.enabled) return;
    this.enabled = true;
    const generation = this.generation;
    this.state = "Checking subscription limits…";
    await this.render();
    if (generation === this.generation && this.enabled) await this.check(true);
  }

  clear(state: string): boolean {
    const wasPending = this.enabled;
    this.enabled = false;
    this.eligible = false;
    this.cancelTimer();
    this.generation++;
    const id = this.messageId;
    this.messageId = null;
    if (id !== null) {
      const text = `${this.failure}\n\n${state}`;
      this.edits = this.edits.then(async () => {
        await this.out.edit(id, text);
        await this.bot.api.editMessageReplyMarkup(cfg.chatId, id, { reply_markup: { inline_keyboard: [] } });
      }).catch(err => console.warn("[quota] clearing buttons failed:", String(err)));
    }
    return wasPending;
  }

  private cancelTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async check(allowRetry: boolean, resetDue = false, periodic = false): Promise<void> {
    const generation = this.generation;
    if (!this.enabled) return;
    this.cancelTimer();
    const checkId = ++this.checkId;
    let limits: PlanLimits | null = null;
    try { limits = await this.readLimits(); }
    catch (err) { console.warn("[quota] limit check failed:", String(err)); }
    if (generation !== this.generation || checkId !== this.checkId || !this.enabled) return;
    const status = quotaStatus(limits, Date.now(), this.model());
    const unknown = !limits?.windows.length || (!status.blocked && !status.ready);
    if (allowRetry && (status.ready || (resetDue && status.resetAt === null) || (periodic && unknown))) {
      this.eligible = false;
      this.state = "Retrying the task in the same session…";
      await this.render();
      if (generation !== this.generation || !this.enabled) return;
      try {
        if (await this.retry()) return;
      } catch (err) { console.warn("[quota] retry failed:", String(err)); }
      if (generation === this.generation) this.clear("Could not resume automatically. Send a new message to continue.");
      return;
    }
    const resetAt = status.resetAt ?? (this.resetHint !== null && this.resetHint > Date.now() ? this.resetHint : null);
    const delay = resetAt === null ? status.delay : Math.min(status.delay, resetAt - Date.now());
    const nextAt = Date.now() + delay;
    this.state = resetAt === null
      ? "Waiting for subscription limits. Next check in 20 minutes."
      : `Waiting for subscription limits. Reported reset: ${new Date(resetAt).toISOString()}. Checks every 20 minutes and at reset.`;
    // Arm before rendering: Telegram latency must not move the quota timer.
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.check(true, resetAt !== null && nextAt >= resetAt, true)
        .catch(err => console.warn("[quota] scheduled check failed:", String(err)));
    }, delay);
    await this.render();
  }

  private async render(): Promise<void> {
    const generation = this.generation;
    const text = `${this.failure}\n\n${this.state}`;
    const kb = new InlineKeyboard();
    if (!this.enabled) kb.text("⏳ Wait and retry", `quota:${this.threadId}:wait`);
    kb.text("⏹ Stop", `quota:${this.threadId}:stop`);
    this.edits = this.edits.then(async () => {
      if (generation !== this.generation) return;
      if (this.messageId === null) {
        const id = await this.out.sendText(text, { replyMarkup: kb });
        if (generation !== this.generation) {
          if (id !== null) await this.bot.api.editMessageReplyMarkup(cfg.chatId, id, { reply_markup: { inline_keyboard: [] } });
          return;
        }
        this.messageId = id;
      } else {
        await this.out.edit(this.messageId, text);
        await this.bot.api.editMessageReplyMarkup(cfg.chatId, this.messageId, { reply_markup: kb });
      }
    }).catch(err => console.warn("[quota] delivery failed:", String(err)));
    await this.edits;
  }
}
