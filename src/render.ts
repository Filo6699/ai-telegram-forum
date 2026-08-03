import type { Bot } from "grammy";
import telegramify from "telegramify-markdown";
import { toTelegramHtml } from "./html.js";

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

/**
 * Collects a turn's output and posts it to a forum topic once the turn is
 * finished. Nothing is sent while the turn runs: partial markdown can't be
 * rendered reliably, and half-written messages only add noise to the topic.
 *
 * On send(), each chunk goes out as MarkdownV2 so code blocks, inline code and
 * bold render properly. If Telegram rejects that, the chunk is re-sent as
 * Telegram HTML — a stricter renderer that emits balanced tags and escapes
 * everything else, so formatting survives input MarkdownV2 chokes on. Plain
 * text is the last resort, so a message is never lost to a formatting error.
 * An empty buffer sends nothing at all.
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

  /**
   * Send one chunk, degrading gracefully: MarkdownV2 → HTML → plain text.
   *
   * Formatted output is never truncated — cutting mid-escape or mid-tag is
   * exactly what breaks the parse. A rendering that overflows the limit is
   * skipped in favour of the next tier, and chunkRaw() keeps chunks small
   * enough that this stays rare.
   */
  private async sendOne(raw: string): Promise<void> {
    const attempts: Array<{ text: string | null; mode?: "MarkdownV2" | "HTML" }> = [
      { text: safeFormat(raw), mode: "MarkdownV2" },
      { text: safeRender(toTelegramHtml, raw), mode: "HTML" },
      { text: raw.slice(0, TG_LIMIT) },
    ];

    for (const { text, mode } of attempts) {
      if (!text || (mode && text.length > TG_LIMIT)) continue;
      try {
        await this.bot.api.sendMessage(this.chatId, text, {
          message_thread_id: this.threadId,
          ...(mode ? { parse_mode: mode } : {}),
        });
        return;
      } catch (err) {
        const next = mode === "MarkdownV2" ? "HTML" : mode === "HTML" ? "plain" : "nothing";
        console.warn(`[render] ${mode ?? "plain"} rejected, falling back to ${next}:`, String(err));
      }
    }
  }

  /** Post the collected output; call once the turn is complete. */
  async send(): Promise<void> {
    for (const chunk of this.chunkRaw(this.buffer)) {
      await this.sendOne(chunk);
    }
    this.buffer = "";
  }
}
