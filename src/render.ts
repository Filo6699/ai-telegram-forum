import type { Bot } from "grammy";
import telegramify from "telegramify-markdown";

const TG_LIMIT = 4096;
const RAW_CHUNK = 2800; // raw markdown per message; formatted stays under TG_LIMIT

/** Convert markdown to Telegram MarkdownV2; null if it can't be parsed. */
function safeFormat(raw: string): string | null {
  try {
    const out = telegramify(raw, "escape");
    return out.length ? out : null;
  } catch {
    return null;
  }
}

/**
 * Collects a turn's output and posts it to a forum topic once the turn is
 * finished. Nothing is sent while the turn runs: partial markdown can't be
 * rendered reliably, and half-written messages only add noise to the topic.
 *
 * On send(), each chunk goes out as MarkdownV2 so code blocks, inline code and
 * bold render properly. If a chunk fails to parse or Telegram rejects the
 * formatting, it falls back to plain text, so a message is never lost to a
 * formatting error. An empty buffer sends nothing at all.
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

  private async sendOne(raw: string): Promise<void> {
    const formatted = safeFormat(raw);
    if (formatted) {
      try {
        await this.bot.api.sendMessage(this.chatId, formatted.slice(0, TG_LIMIT), {
          message_thread_id: this.threadId,
          parse_mode: "MarkdownV2",
        });
        return;
      } catch (err) {
        console.warn(`[render] MarkdownV2 rejected, retrying plain:`, String(err));
      }
    }
    try {
      await this.bot.api.sendMessage(this.chatId, raw.slice(0, TG_LIMIT), {
        message_thread_id: this.threadId,
      });
    } catch (err) {
      console.warn(`[render] send failed:`, String(err));
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
