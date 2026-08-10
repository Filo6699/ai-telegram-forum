import type { Bot } from "grammy";
import telegramify from "telegramify-markdown";
import { toTelegramHtml } from "./html.js";
import { flattenTables } from "./tables.js";

const TG_LIMIT = 4096;
const RAW_CHUNK = 2800; // raw markdown per message; formatted stays under TG_LIMIT

/** Run a renderer, returning null if it throws or produces nothing. */
function safeRender(fn: (s: string) => string, raw: string): string | null {
  try {
    const out = fn(raw);
    return out.length ? out : null;
  } catch {
    return null;
  }
}

/** Convert markdown to Telegram MarkdownV2; null if it can't be parsed. */
const safeFormat = (raw: string): string | null =>
  safeRender((s) => telegramify(s, "escape"), raw);

type Mode = "MarkdownV2" | "HTML" | undefined;

/**
 * Rendering tiers for one chunk, best first. Formatted output is never
 * truncated — cutting mid-escape or mid-tag is exactly what breaks the parse;
 * an overflowing rendering is skipped in favour of the next tier.
 */
function tiers(raw: string): Array<{ text: string | null; mode: Mode }> {
  return [
    { text: safeFormat(raw), mode: "MarkdownV2" },
    { text: safeRender(toTelegramHtml, raw), mode: "HTML" },
    { text: raw.slice(0, TG_LIMIT), mode: undefined },
  ];
}

/**
 * Posts markdown into a forum topic, degrading gracefully: MarkdownV2 →
 * Telegram HTML → plain text, so a message is never lost to a formatting error.
 *
 * Two ways in. `sendText` posts immediately — that is what the agent's
 * `mcp__tg__send` tool uses, and what makes a topic feel live. `push`/`send`
 * buffer a whole turn and post it at the end; that path is the fallback for a
 * turn where the agent never spoke through the tool, so a reply the session
 * recorded can't be dropped on the floor.
 */
export class TopicRenderer {
  private buffer = "";

  constructor(
    private bot: Bot,
    private chatId: number,
    private threadId: number,
  ) {}

  push(text: string): void {
    this.buffer += text;
  }

  clear(): void {
    this.buffer = "";
  }

  get isEmpty(): boolean {
    return this.buffer.trim().length === 0;
  }

  /** Split raw markdown into <=RAW_CHUNK pieces without breaking code fences. */
  private chunkRaw(text: string): string[] {
    const lines = text.split("\n");
    const chunks: string[] = [];
    let cur: string[] = [];
    let curLen = 0;
    let fenceLang: string | null = null; // null = outside a fence

    const flushCur = () => {
      if (cur.length) {
        chunks.push(cur.join("\n"));
        cur = [];
        curLen = 0;
      }
    };

    for (const line of lines) {
      const isFence = line.trimStart().startsWith("```");
      if (curLen + line.length + 1 > RAW_CHUNK && cur.length) {
        if (fenceLang !== null) {
          cur.push("```"); // close current block
          flushCur();
          cur.push("```" + fenceLang); // reopen in the next message
          curLen = 3 + fenceLang.length;
        } else {
          flushCur();
        }
      }
      cur.push(line);
      curLen += line.length + 1;
      if (isFence) fenceLang = fenceLang === null ? line.trimStart().slice(3) : null;
    }
    flushCur();
    return chunks.filter((c) => c.trim().length > 0);
  }

  /** Send one chunk. Returns its message id, or null if every tier failed. */
  private async sendOne(raw: string): Promise<number | null> {
    for (const { text, mode } of tiers(raw)) {
      if (!text || (mode && text.length > TG_LIMIT)) continue;
      try {
        const sent = await this.bot.api.sendMessage(this.chatId, text, {
          message_thread_id: this.threadId,
          ...(mode ? { parse_mode: mode } : {}),
        });
        return sent.message_id;
      } catch (err) {
        const next = mode === "MarkdownV2" ? "HTML" : mode === "HTML" ? "plain" : "nothing";
        console.warn(`[render] ${mode ?? "plain"} rejected, falling back to ${next}:`, String(err));
      }
    }
    return null;
  }

  /** Post text now. Returns the last message id sent, or null if nothing went out. */
  async sendText(raw: string): Promise<number | null> {
    let last: number | null = null;
    for (const chunk of this.chunkRaw(flattenTables(raw))) {
      const id = await this.sendOne(chunk);
      if (id !== null) last = id;
    }
    return last;
  }

  /**
   * Rewrite an earlier message. Used for the live status line, which is edited
   * many times per turn — edits don't notify, so this stays quiet.
   */
  async edit(messageId: number, raw: string): Promise<boolean> {
    for (const { text, mode } of tiers(flattenTables(raw).slice(0, RAW_CHUNK))) {
      if (!text || (mode && text.length > TG_LIMIT)) continue;
      try {
        await this.bot.api.editMessageText(this.chatId, messageId, text, {
          ...(mode ? { parse_mode: mode } : {}),
        });
        return true;
      } catch (err) {
        const msg = String(err);
        // Editing to identical content is a no-op, not a failure.
        if (msg.includes("message is not modified")) return true;
        console.warn(`[render] edit ${mode ?? "plain"} rejected:`, msg);
      }
    }
    return false;
  }

  /** Post the buffered turn; call once the turn is complete. */
  async send(): Promise<void> {
    const raw = this.buffer;
    this.buffer = "";
    await this.sendText(raw);
  }
}
