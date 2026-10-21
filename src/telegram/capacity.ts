import { InlineKeyboard, type Bot } from "grammy";
import { cfg } from "../config/env.ts";
import { CapacityRetryWait, DEFAULT_CAPACITY_RETRIES } from "../sessions/capacity-retry.ts";
import { getTopic } from "../storage/db.ts";
import { TopicRenderer } from "./render.ts";

export function capacityKeyboard(threadId: number, canRetry: boolean): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text("⚙️ Retry settings", `cap:${threadId}:settings`)
    .text("Change model", `cap:${threadId}:model`);
  if (canRetry) kb.row()
    .text("🔄 Retry now", `cap:${threadId}:retry`)
    .text("⏹ Stop", `cap:${threadId}:stop`);
  return kb;
}

export type CapacityAction = "settings" | "model" | "retry" | "stop";

export function registerCapacityButtons(
  bot: Bot,
  act: (threadId: number, action: CapacityAction, messageId: number, ctx: any) => void | Promise<void>,
): void {
  bot.on("callback_query:data", async (ctx, next) => {
    const match = /^cap:(\d+):(settings|model|retry|stop)$/.exec(ctx.callbackQuery.data);
    if (!match) return next();
    const threadId = Number(match[1]);
    const message = ctx.callbackQuery.message;
    if (ctx.from.id !== cfg.allowedUserId || message?.chat.id !== cfg.chatId || message.message_thread_id !== threadId) {
      await ctx.answerCallbackQuery({ text: "Not authorized." }).catch(() => {});
      return;
    }
    const topic = getTopic(threadId);
    if (!topic || topic.provider !== "codex" || topic.status !== "active") {
      await ctx.answerCallbackQuery({ text: "This session is closed." }).catch(() => {});
      return;
    }
    await ctx.answerCallbackQuery().catch(() => {});
    // Pickers and retries must leave the update loop free for further buttons.
    void Promise.resolve().then(() => act(threadId, match[2] as CapacityAction, message.message_id, ctx))
      .catch(async err => {
        console.warn("[capacity] button action failed:", String(err));
        await bot.api.sendMessage(cfg.chatId, `⚠️ Could not apply capacity recovery action: ${String(err).slice(0, 500)}`, {
          message_thread_id: threadId,
        }).catch(deliveryError => console.warn("[capacity] notice failed:", String(deliveryError)));
      });
  });
}

/** One error message per capacity episode; retry attempts edit it in place. */
export class CapacityRecovery {
  private wait = new CapacityRetryWait();
  private messageId: number | null = null;
  private failure = "";
  private retries = 0;
  private canRetry = false;
  private state = "";
  private generation = 0;
  private edits: Promise<unknown> = Promise.resolve();

  constructor(private bot: Bot, private threadId: number, private out: TopicRenderer) {}

  get pending(): boolean { return this.wait.pending; }

  owns(messageId: number): boolean { return this.messageId === messageId; }

  pause(): () => void { return this.wait.pause(); }

  retryNow(): boolean { return this.wait.finish(true); }

  async recover(failure: string, retries: number, canRetry: boolean): Promise<boolean> {
    const generation = this.generation;
    this.failure = failure;
    this.retries = retries;
    this.canRetry = canRetry;
    const limit = getTopic(this.threadId)?.capacity_retries ?? DEFAULT_CAPACITY_RETRIES;
    const decision = canRetry && retries < limit ? this.wait.wait() : null;
    this.state = !canRetry ? "Automatic recovery cancelled. Send a new message to continue."
      : limit === 0 ? "Automatic retries are off."
      : retries >= limit ? `Retry limit reached (${retries}/${limit}).`
      : `Retry ${retries + 1}/${limit} in 30 seconds.`;
    await this.render();
    if (!decision) return false;
    const retry = await decision;
    if (generation !== this.generation) return false;
    this.state = retry ? `Retrying (${retries + 1})…` : "Automatic retries stopped.";
    await this.render();
    return retry;
  }

  async settingsChanged(): Promise<void> {
    if (!this.wait.pending) return;
    const limit = getTopic(this.threadId)?.capacity_retries ?? DEFAULT_CAPACITY_RETRIES;
    if (this.retries >= limit) {
      this.wait.finish(false);
      return;
    }
    this.state = `Retry ${this.retries + 1}/${limit} in 30 seconds.`;
    await this.render();
  }

  /** Also invalidates a Telegram send still in flight when input/stop arrives. */
  clear(state: string): boolean {
    const cancelled = this.wait.finish(false);
    this.generation++;
    const messageId = this.messageId;
    this.messageId = null;
    if (messageId !== null) {
      const text = `${this.failure}\n\n${state}`;
      this.edits = this.edits.then(() => this.out.edit(messageId, text))
        .then(() => this.bot.api.editMessageReplyMarkup(cfg.chatId, messageId, { reply_markup: { inline_keyboard: [] } }))
        .catch(err => console.warn("[capacity] clearing buttons failed:", String(err)));
    }
    return cancelled;
  }

  private async render(): Promise<void> {
    const generation = this.generation;
    const text = `${this.failure}\n\n${this.state}`;
    const markup = capacityKeyboard(this.threadId, this.canRetry);
    this.edits = this.edits.then(async () => {
      if (generation !== this.generation) return;
      if (this.messageId === null) {
        const id = await this.out.sendText(text, { replyMarkup: markup });
        if (generation !== this.generation) {
          if (id !== null) await this.bot.api.editMessageReplyMarkup(cfg.chatId, id, { reply_markup: { inline_keyboard: [] } });
          return;
        }
        this.messageId = id;
      } else {
        await this.out.edit(this.messageId, text);
        await this.bot.api.editMessageReplyMarkup(cfg.chatId, this.messageId, { reply_markup: markup });
      }
    }).catch(err => console.warn("[capacity] error message delivery failed:", String(err)));
    await this.edits;
  }
}
