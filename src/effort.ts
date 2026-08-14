import { randomBytes } from "node:crypto";
import { InlineKeyboard, type Bot } from "grammy";
import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import { cfg } from "./config.ts";

/** `null` means "whatever Claude itself defaults to" — we never store a default of our own. */
export type Effort = EffortLevel | null;

const LEVELS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

/** How long an untouched launch picker waits before the new session just starts. */
export const LAUNCH_WAIT_MS = 5_000;

/** How long a picker waits for the next press once the user has started choosing. */
export const PICK_WAIT_MS = 60_000;

export const effortLabel = (e: Effort): string => e ?? "default";

/** Parse a `/effort <level>` argument. `undefined` = not a level we know. */
export function parseEffort(raw: string): Effort | undefined {
  const v = raw.trim().toLowerCase();
  if (v === "default" || v === "reset" || v === "-") return null;
  return (LEVELS as string[]).includes(v) ? (v as EffortLevel) : undefined;
}

/** What `/effort` says when it doesn't recognise its argument. */
export const effortUsage = `⚠️ unknown effort. Use one of: ${LEVELS.join(", ")}, default.`;

interface Picker {
  messageId: number;
  threadId: number | undefined;
  selection: Effort;
  timer: ReturnType<typeof setTimeout>;
  settle: (choice: Effort) => void;
}

const pickers = new Map<string, Picker>();

function keyboard(id: string, selection: Effort): InlineKeyboard {
  const mark = (e: Effort, text: string) => (e === selection ? `✓ ${text}` : text);
  return new InlineKeyboard()
    .text(mark(null, "default"), `e:${id}:default`)
    .text(mark("low", "low"), `e:${id}:low`)
    .text(mark("medium", "medium"), `e:${id}:medium`)
    .row()
    .text(mark("high", "high"), `e:${id}:high`)
    .text(mark("xhigh", "xhigh"), `e:${id}:xhigh`)
    .text(mark("max", "max"), `e:${id}:max`)
    .row()
    .text("✅ Confirm", `e:${id}:ok`);
}

/**
 * Put the effort buttons on screen and resolve with what the user settled on.
 *
 * The first wait is short for a launch picker — a new session must not sit
 * waiting on a phone nobody picked up — but the moment the user touches a
 * button the picker switches to `PICK_WAIT_MS` between presses and resolves on
 * whatever was selected last, pressed Confirm or not.
 *
 * Never rejects: a picker that can't even be posted resolves as `initial`, so
 * the caller's flow always continues.
 */
export function askEffort(
  bot: Bot,
  opts: {
    threadId: number | undefined;
    title: string;
    initial: Effort;
    /** Wait before the first press. Defaults to the full pick window. */
    firstWaitMs?: number;
  },
): Promise<Effort> {
  return new Promise<Effort>((resolve) => {
    const id = randomBytes(4).toString("hex");
    const title = opts.title
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    const text = `⚙️ <b>${title}</b>`;

    void bot.api
      .sendMessage(cfg.chatId, text, {
        message_thread_id: opts.threadId,
        parse_mode: "HTML",
        reply_markup: keyboard(id, opts.initial),
      })
      .then(
        (sent) => {
          const settle = (choice: Effort) => {
            const p = pickers.get(id);
            pickers.delete(id);
            if (p) clearTimeout(p.timer);
            resolve(choice);
            void bot.api
              .editMessageText(cfg.chatId, sent.message_id, `⚙️ effort: <b>${effortLabel(choice)}</b>`, {
                parse_mode: "HTML",
              })
              .catch(() => {});
          };
          pickers.set(id, {
            messageId: sent.message_id,
            threadId: opts.threadId,
            selection: opts.initial,
            timer: setTimeout(
              () => settle(opts.initial),
              opts.firstWaitMs ?? PICK_WAIT_MS,
            ),
            settle,
          });
        },
        (err) => {
          console.warn("[effort] could not show the picker:", String(err));
          resolve(opts.initial);
        },
      );
  });
}

/**
 * Wire the effort buttons. Like the permission buttons, this is an inbound path
 * the message handler never sees, so it checks the user itself. Callbacks that
 * aren't ours are passed on — the permission buttons are the next handler.
 */
export function registerEffortButtons(bot: Bot): void {
  bot.on("callback_query:data", async (ctx, next) => {
    const m = /^e:([0-9a-f]{8}):([a-z]+)$/.exec(ctx.callbackQuery.data);
    if (!m) return next();
    if (ctx.from.id !== cfg.allowedUserId) {
      return void ctx.answerCallbackQuery({ text: "Not authorized." }).catch(() => {});
    }

    const id = m[1]!;
    const value = m[2]!;
    const p = pickers.get(id);
    if (!p) {
      return void ctx
        .answerCallbackQuery({ text: "That picker is closed." })
        .catch(() => {});
    }

    if (value === "ok") {
      p.settle(p.selection);
      return void ctx.answerCallbackQuery({ text: effortLabel(p.selection) }).catch(() => {});
    }

    const choice = parseEffort(value);
    if (choice === undefined) return void ctx.answerCallbackQuery().catch(() => {});

    // Every press restarts the clock: once the user is choosing, we wait.
    p.selection = choice;
    clearTimeout(p.timer);
    p.timer = setTimeout(() => p.settle(p.selection), PICK_WAIT_MS);
    await ctx.answerCallbackQuery().catch(() => {});
    await ctx.api
      .editMessageReplyMarkup(cfg.chatId, p.messageId, { reply_markup: keyboard(id, choice) })
      .catch(() => {});
  });
}
