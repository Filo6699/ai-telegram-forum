import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { InlineKeyboard, type Bot } from "grammy";
import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import { cfg } from "./config.ts";

/** `null` means "whatever Claude itself defaults to" — we never store a default of our own. */
export type Effort = EffortLevel | null;

const LEVELS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

/** What the SDK documents as the effort a model runs on when nothing sets one. */
const BUILT_IN_DEFAULT: EffortLevel = "high";

/** How long an untouched launch picker waits before the new session just starts. */
export const LAUNCH_WAIT_MS = 5_000;

/** How long a picker waits for the next press once the user has started choosing. */
export const PICK_WAIT_MS = 60_000;

/**
 * The level Claude itself would run on in `cwd` — the one shown pre-selected,
 * since "default" is a level like any other, not a menu entry of its own.
 * Read from the settings files the CLI reads, in its precedence order, so it
 * follows a `/effort` the user set in a terminal instead of us keeping a copy.
 */
export function defaultEffort(cwd: string): EffortLevel {
  const files = [
    "/etc/claude-code/managed-settings.json",
    join(cwd, ".claude", "settings.local.json"),
    join(cwd, ".claude", "settings.json"),
    join(homedir(), ".claude", "settings.json"),
  ];
  for (const file of files) {
    const level = readEffortLevel(file);
    if (level) return level;
  }
  return BUILT_IN_DEFAULT;
}

function readEffortLevel(file: string): EffortLevel | null {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { effortLevel?: string };
    return (raw.effortLevel ? parseEffort(raw.effortLevel) : null) ?? null;
  } catch {
    return null; // missing, unreadable or not JSON — the next source answers
  }
}

/** `fallback` names the level an unset effort resolves to, when we know it. */
export const effortLabel = (e: Effort, fallback?: EffortLevel): string =>
  e ?? (fallback ? `${fallback} (default)` : "default");

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
  fallback: EffortLevel;
  timer: ReturnType<typeof setTimeout>;
  settle: (choice: Effort) => void;
}

const pickers = new Map<string, Picker>();

/**
 * The five levels, tick on the one in force. Nothing picked yet means the
 * session runs on `fallback`, so that is what the tick sits on — the default is
 * a level, not an extra button.
 */
function keyboard(id: string, selection: Effort, fallback: EffortLevel): InlineKeyboard {
  const active = selection ?? fallback;
  const mark = (e: EffortLevel) => (e === active ? `✓ ${e}` : e);
  return new InlineKeyboard()
    .text(mark("low"), `e:${id}:low`)
    .text(mark("medium"), `e:${id}:medium`)
    .text(mark("high"), `e:${id}:high`)
    .row()
    .text(mark("xhigh"), `e:${id}:xhigh`)
    .text(mark("max"), `e:${id}:max`)
    .row()
    .text("✅ Confirm", `e:${id}:ok`);
}

export interface EffortChoice {
  level: Effort;
  /** The picker's own message, for a caller that would rather rewrite it than
   * post a second one. `null` when the picker never made it onto the screen. */
  messageId: number | null;
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
    /** Where the session runs — the default level is read from its settings. */
    cwd: string;
    /** Wait before the first press. Defaults to the full pick window. */
    firstWaitMs?: number;
    /**
     * The caller will rewrite the picker's message itself, so settling only
     * takes the buttons off. Without this the two edits would race, and the
     * loser's text is what stays on screen.
     */
    rewritten?: boolean;
  },
): Promise<EffortChoice> {
  return new Promise<EffortChoice>((resolve) => {
    const id = randomBytes(4).toString("hex");
    const fallback = defaultEffort(opts.cwd);
    const title = opts.title
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    const text = `⚙️ <b>${title}</b>`;

    void bot.api
      .sendMessage(cfg.chatId, text, {
        message_thread_id: opts.threadId,
        parse_mode: "HTML",
        reply_markup: keyboard(id, opts.initial, fallback),
      })
      .then(
        (sent) => {
          const settle = (choice: Effort) => {
            const p = pickers.get(id);
            pickers.delete(id);
            if (p) clearTimeout(p.timer);
            resolve({ level: choice, messageId: sent.message_id });
            if (opts.rewritten) {
              void bot.api.editMessageReplyMarkup(cfg.chatId, sent.message_id).catch(() => {});
              return;
            }
            const label = effortLabel(choice, fallback);
            void bot.api
              .editMessageText(cfg.chatId, sent.message_id, `⚙️ effort: <b>${label}</b>`, {
                parse_mode: "HTML",
              })
              .catch(() => {});
          };
          pickers.set(id, {
            messageId: sent.message_id,
            threadId: opts.threadId,
            selection: opts.initial,
            fallback,
            timer: setTimeout(
              () => settle(opts.initial),
              opts.firstWaitMs ?? PICK_WAIT_MS,
            ),
            settle,
          });
        },
        (err) => {
          console.warn("[effort] could not show the picker:", String(err));
          resolve({ level: opts.initial, messageId: null });
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
      const label = effortLabel(p.selection, p.fallback);
      return void ctx.answerCallbackQuery({ text: label }).catch(() => {});
    }

    // Only the five levels are on the keyboard — "default" is never a press.
    const choice = parseEffort(value);
    if (!choice) return void ctx.answerCallbackQuery().catch(() => {});

    // Every press restarts the clock: once the user is choosing, we wait.
    p.selection = choice;
    clearTimeout(p.timer);
    p.timer = setTimeout(() => p.settle(p.selection), PICK_WAIT_MS);
    await ctx.answerCallbackQuery().catch(() => {});
    await ctx.api
      .editMessageReplyMarkup(cfg.chatId, p.messageId, {
        reply_markup: keyboard(id, choice, p.fallback),
      })
      .catch(() => {});
  });
}
