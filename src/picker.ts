import { randomBytes } from "node:crypto";
import { InlineKeyboard, type Bot } from "grammy";
import { cfg } from "./config.ts";

/**
 * The inline-button picker both `/effort` and `/model` are built on.
 *
 * A picker is one message holding one or more *groups* of buttons — a launch
 * offers the model and the effort together rather than posting a prompt each,
 * which would mean two timeouts and two plaques for one launch. Each group
 * settles on its own value, and one Confirm ends the whole thing.
 */

/** What a group settles on. `null` = nothing of ours; the group's fallback stands. */
export type PickValue = string | null;

export interface PickOption {
  value: string;
  label: string;
}

export interface PickGroup {
  /** One letter, unique within the picker — only ever seen in callback data. */
  key: string;
  options: PickOption[];
  /** Buttons per row: model names are wider than effort levels. */
  perRow: number;
  /** What is in force now; `null` means `fallback` is what the tick sits on. */
  initial: PickValue;
  /** The value an unset group resolves to. Always one of `options`. */
  fallback: string;
  /** How the settled line names this group, in plain text (`⚙️ effort: high`). */
  summary: (value: PickValue) => string;
}

/** Each group's choice, by group key. */
export type Picks = Record<string, PickValue>;

export interface PickResult {
  picks: Picks;
  /** True only when the user explicitly cancelled the picker. */
  cancelled: boolean;
  /** The picker's own message, for a caller that would rather rewrite it than
   * post a second one. `null` when the picker never made it onto the screen. */
  messageId: number | null;
}

/** How long an untouched launch picker waits before the new session just starts. */
export const LAUNCH_WAIT_MS = 5_000;

/** How long a picker waits for the next press once the user has started choosing. */
export const PICK_WAIT_MS = 60_000;

interface Live {
  messageId: number;
  groups: PickGroup[];
  selection: Picks;
  allowCancel: boolean;
  timer: ReturnType<typeof setTimeout>;
  settle: (cancelled?: boolean) => void;
}

const pickers = new Map<string, Live>();

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Every group's buttons, a tick on whatever each one is currently on. */
function keyboard(
  id: string,
  groups: PickGroup[],
  selection: Picks,
  allowCancel: boolean,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const g of groups) {
    const active = selection[g.key] ?? g.fallback;
    g.options.forEach((o, i) => {
      kb.text(o.value === active ? `✓ ${o.label}` : o.label, `p:${id}:${g.key}:${i}`);
      if ((i + 1) % g.perRow === 0) kb.row();
    });
    if (g.options.length % g.perRow !== 0) kb.row();
  }
  kb.text("✅ Confirm", `p:${id}:ok`);
  if (allowCancel) kb.text("✖️ Cancel", `p:${id}:cancel`);
  return kb;
}

const settledText = (groups: PickGroup[], selection: Picks): string =>
  `<b>${escapeHtml(groups.map((g) => g.summary(selection[g.key] ?? null)).join(" · "))}</b>`;

/**
 * Put the buttons on screen and resolve with what the user settled on.
 *
 * The first wait is short for a launch picker — a new session must not sit
 * waiting on a phone nobody picked up — but the moment the user touches a
 * button the picker switches to `PICK_WAIT_MS` between presses and resolves on
 * whatever was selected last, pressed Confirm or not.
 *
 * Never rejects: a picker that can't even be posted resolves as the initial
 * selection, so the caller's flow always continues.
 */
export function askPick(
  bot: Bot,
  opts: {
    threadId: number | undefined;
    title: string;
    groups: PickGroup[];
    /** Wait before the first press. Defaults to the full pick window. */
    firstWaitMs?: number;
    /** Offer an explicit way to abort the caller's flow. */
    allowCancel?: boolean;
    /**
     * The caller will rewrite the picker's message itself, so settling only
     * takes the buttons off. Without this the two edits would race, and the
     * loser's text is what stays on screen.
     */
    rewritten?: boolean;
  },
): Promise<PickResult> {
  return new Promise<PickResult>((resolve) => {
    const id = randomBytes(4).toString("hex");
    const groups = opts.groups;
    const initial: Picks = Object.fromEntries(groups.map((g) => [g.key, g.initial]));
    const text = `⚙️ <b>${escapeHtml(opts.title)}</b>`;

    void bot.api
      .sendMessage(cfg.chatId, text, {
        message_thread_id: opts.threadId,
        parse_mode: "HTML",
        reply_markup: keyboard(id, groups, initial, opts.allowCancel ?? false),
      })
      .then(
        (sent) => {
          const settle = (cancelled = false) => {
            const p = pickers.get(id);
            pickers.delete(id);
            if (p) clearTimeout(p.timer);
            const picks = p?.selection ?? initial;
            resolve({ picks: { ...picks }, cancelled, messageId: sent.message_id });
            if (cancelled) {
              void bot.api
                .editMessageText(
                  cfg.chatId,
                  sent.message_id,
                  `✖️ <b>Cancelled</b> · ${escapeHtml(opts.title)}`,
                  { parse_mode: "HTML" },
                )
                .catch(() => {});
              return;
            }
            if (opts.rewritten) {
              void bot.api.editMessageReplyMarkup(cfg.chatId, sent.message_id).catch(() => {});
              return;
            }
            void bot.api
              .editMessageText(cfg.chatId, sent.message_id, settledText(groups, picks), {
                parse_mode: "HTML",
              })
              .catch(() => {});
          };
          pickers.set(id, {
            messageId: sent.message_id,
            groups,
            selection: { ...initial },
            allowCancel: opts.allowCancel ?? false,
            timer: setTimeout(settle, opts.firstWaitMs ?? PICK_WAIT_MS),
            settle,
          });
        },
        (err) => {
          console.warn("[picker] could not show the picker:", String(err));
          resolve({ picks: initial, cancelled: false, messageId: null });
        },
      );
  });
}

/**
 * Wire the picker buttons. Like the permission buttons, this is an inbound path
 * the message handler never sees, so it checks the user itself. Callbacks that
 * aren't ours are passed on — the permission buttons are the next handler.
 */
export function registerPickerButtons(bot: Bot): void {
  bot.on("callback_query:data", async (ctx, next) => {
    const m = /^p:([0-9a-f]{8}):([a-z]+)(?::(\d+))?$/.exec(ctx.callbackQuery.data);
    if (!m) return next();
    if (ctx.from.id !== cfg.allowedUserId) {
      return void ctx.answerCallbackQuery({ text: "Not authorized." }).catch(() => {});
    }

    const id = m[1]!;
    const key = m[2]!;
    const index = m[3];
    const p = pickers.get(id);
    if (!p) {
      return void ctx.answerCallbackQuery({ text: "That picker is closed." }).catch(() => {});
    }

    if (key === "ok" && index === undefined) {
      const label = p.groups.map((g) => g.summary(p.selection[g.key] ?? null)).join(" · ");
      p.settle();
      return void ctx.answerCallbackQuery({ text: label }).catch(() => {});
    }

    if (key === "cancel" && index === undefined && p.allowCancel) {
      p.settle(true);
      return void ctx.answerCallbackQuery({ text: "Cancelled" }).catch(() => {});
    }

    const group = p.groups.find((g) => g.key === key);
    const option = group?.options[Number(index)];
    if (!group || !option) return void ctx.answerCallbackQuery().catch(() => {});

    // Every press restarts the clock: once the user is choosing, we wait.
    p.selection[key] = option.value;
    clearTimeout(p.timer);
    p.timer = setTimeout(p.settle, PICK_WAIT_MS);
    await ctx.answerCallbackQuery().catch(() => {});
    await ctx.api
      .editMessageReplyMarkup(cfg.chatId, p.messageId, {
        reply_markup: keyboard(id, p.groups, p.selection, p.allowCancel),
      })
      .catch(() => {});
  });
}
