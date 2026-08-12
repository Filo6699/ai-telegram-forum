import { randomBytes } from "node:crypto";
import { InlineKeyboard, type Bot } from "grammy";
import { cfg } from "./config.ts";

export type Decision = "allow" | "deny";

interface Pending {
  threadId: number;
  messageId: number;
  tool: string;
  timer: ReturnType<typeof setTimeout>;
}

/** Open requests, once their prompt is on screen. */
const pending = new Map<string, Pending>();

/**
 * Waiting callers, indexed the moment a request is created — before the
 * sendMessage round-trip finishes, so a request that is settled in that window
 * (the session ending, say) still unblocks the tool call.
 */
const resolvers = new Map<string, (d: Decision) => void>();

/** Tools the user waved through for the rest of a topic's session. */
const blanket = new Map<number, Set<string>>();

export function isBlanketAllowed(threadId: number, tool: string): boolean {
  return blanket.get(threadId)?.has(tool) ?? false;
}

/** Forget a topic's granted permissions — called when its session ends. */
export function clearPermissions(threadId: number): void {
  blanket.delete(threadId);
  denyPending(threadId, "session ended");
}

/**
 * Settle a topic's open prompts as denials. An interrupt aborts the turn, but a
 * tool call parked on a button would otherwise wait for its timeout.
 */
export function denyPending(threadId: number, note: string): void {
  for (const [id, p] of pending) {
    if (p.threadId === threadId) settle(id, "deny", note);
  }
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** What the user needs to see to judge the call. Bash is the common case. */
function describe(tool: string, input: Record<string, unknown>): string {
  if (typeof input.command === "string") return input.command;
  const json = JSON.stringify(input, null, 1);
  return json.length > 700 ? json.slice(0, 700) + "\n…" : json;
}

/**
 * Ask the user, in the topic itself, whether the agent may run a tool that
 * isn't on the allowlist. Resolves when a button is pressed, or denies after
 * `PERMISSION_TIMEOUT_MINUTES` so a turn can't hang forever waiting on a phone
 * nobody is looking at.
 */
export function askPermission(
  bot: Bot,
  threadId: number,
  tool: string,
  input: Record<string, unknown>,
  warning?: string,
): Promise<Decision> {
  return new Promise<Decision>((resolve) => {
    const id = randomBytes(4).toString("hex");
    resolvers.set(id, resolve);
    const head = warning ? `⚠️ <b>${esc(warning)}</b>\n🔐 ` : "🔐 ";
    const text = `${head}<b>${esc(tool)}</b>\n<pre>${esc(describe(tool, input))}</pre>`;
    const keyboard = new InlineKeyboard()
      .text("✅ Allow", `p:a:${id}`)
      .text("❌ Deny", `p:d:${id}`)
      .row()
      .text(`✅ Always allow ${tool} here`, `p:s:${id}`);

    void bot.api
      .sendMessage(cfg.chatId, text, {
        message_thread_id: threadId,
        parse_mode: "HTML",
        reply_markup: keyboard,
      })
      .then(
        (sent) => {
          // Settled while the prompt was in flight — leave it be.
          if (!resolvers.has(id)) return;
          const timer = setTimeout(
            () => settle(id, "deny", "timed out"),
            cfg.permissionTimeoutMs,
          );
          pending.set(id, { threadId, messageId: sent.message_id, tool, timer });
        },
        (err) => {
          // Couldn't even ask — denying is the safe answer.
          console.warn(`[permission] could not ask for ${tool}:`, String(err));
          settle(id, "deny", "");
        },
      );
  });
}

function settle(id: string, decision: Decision, note: string): void {
  const resolve = resolvers.get(id);
  resolvers.delete(id);
  const p = pending.get(id);
  pending.delete(id);
  if (p) clearTimeout(p.timer);
  resolve?.(decision);
  if (!p) return;
  const label = decision === "allow" ? "✅ allowed" : "❌ denied";
  void editOutcome(p, `${label}${note ? ` (${note})` : ""}`);
}

let botRef: Bot | null = null;

async function editOutcome(p: Pending, label: string): Promise<void> {
  if (!botRef) return;
  await botRef.api
    .editMessageText(
      cfg.chatId,
      p.messageId,
      `🔐 <b>${esc(p.tool)}</b> — ${esc(label)}`,
      { parse_mode: "HTML" },
    )
    .catch(() => {});
}

/**
 * Wire the ✅/❌ buttons. Only the configured user is obeyed — the callback is
 * the one inbound path that isn't already filtered by the message handler.
 */
export function registerPermissionButtons(bot: Bot): void {
  botRef = bot;
  bot.on("callback_query:data", async (ctx) => {
    const m = /^p:([ads]):([0-9a-f]{8})$/.exec(ctx.callbackQuery.data);
    if (!m) return void ctx.answerCallbackQuery().catch(() => {});
    if (ctx.from.id !== cfg.allowedUserId) {
      return void ctx.answerCallbackQuery({ text: "Not authorized." }).catch(() => {});
    }

    const action = m[1]!;
    const id = m[2]!;
    const p = pending.get(id);
    if (!p) {
      return void ctx
        .answerCallbackQuery({ text: "That request is no longer open." })
        .catch(() => {});
    }

    if (action === "s") {
      let set = blanket.get(p.threadId);
      if (!set) blanket.set(p.threadId, (set = new Set()));
      set.add(p.tool);
    }
    const decision: Decision = action === "d" ? "deny" : "allow";
    settle(id, decision, action === "s" ? "always, this topic" : "");
    await ctx
      .answerCallbackQuery({ text: decision === "allow" ? "Allowed" : "Denied" })
      .catch(() => {});
  });
}
