import type { Bot } from "grammy";
import telegramify from "telegramify-markdown";

const TG_LIMIT = 4096;
const RAW_CHUNK = 2800; // raw markdown per message; formatted stays under TG_LIMIT
const MIN_EDIT_INTERVAL_MS = 900; // avoid flood limits (~1 edit/sec)

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
 * Renders a growing markdown buffer into one or more Telegram messages inside a
 * single forum topic.
 *
 * - While streaming, text is sent verbatim (partial markdown can't be parsed
 *   reliably), throttled to ~1 edit/sec.
 * - On finish(), each message is re-rendered as MarkdownV2 so code blocks, inline
 *   code and bold render properly. If a chunk fails to parse, it falls back to
 *   the plain text, so a message is never lost to a formatting error.
 */
export class StreamRenderer {
  private buffer = "";
  private rendered: string[] = []; // last content pushed to each message
  private msgIds: number[] = [];
  private lastEdit = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private bot: Bot,
    private chatId: number,
    private threadId: number,
  ) {}

  push(text: string): void {
    this.buffer += text;
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.timer) return;
    const wait = Math.max(0, MIN_EDIT_INTERVAL_MS - (Date.now() - this.lastEdit));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush(false, false);
    }, wait);
  }

  /** Force a final, formatted flush; call once the turn is complete. */
  async finish(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.flush(true, true);
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
    return chunks.length ? chunks : [""];
  }

  private async editOrSend(
    index: number,
    content: string,
    parseMode: "MarkdownV2" | undefined,
    rawFallback: string,
  ): Promise<void> {
    const body = content.slice(0, TG_LIMIT) || "…";
    if (index < this.msgIds.length) {
      if (this.rendered[index] === body) return; // unchanged
      try {
        await this.bot.api.editMessageText(this.chatId, this.msgIds[index]!, body, {
          parse_mode: parseMode,
        });
        this.rendered[index] = body;
      } catch (err) {
        const msg = String(err);
        if (msg.includes("not modified")) return;
        if (parseMode) {
          // Formatting rejected — retry the same message as plain text.
          const plain = rawFallback.slice(0, TG_LIMIT) || "…";
          try {
            await this.bot.api.editMessageText(this.chatId, this.msgIds[index]!, plain);
            this.rendered[index] = plain;
          } catch (e2) {
            console.warn(`[stream] plain retry failed:`, String(e2));
          }
        } else {
          console.warn(`[stream] edit failed:`, msg);
        }
      }
    } else {
      try {
        const sent = await this.bot.api.sendMessage(this.chatId, body, {
          message_thread_id: this.threadId,
          parse_mode: parseMode,
        });
        this.msgIds.push(sent.message_id);
        this.rendered.push(body);
      } catch (err) {
        if (parseMode) {
          const plain = rawFallback.slice(0, TG_LIMIT) || "…";
          const sent = await this.bot.api.sendMessage(this.chatId, plain, {
            message_thread_id: this.threadId,
          });
          this.msgIds.push(sent.message_id);
          this.rendered.push(plain);
        } else {
          throw err;
        }
      }
    }
  }

  private async flush(force: boolean, format: boolean): Promise<void> {
    if (!force && Date.now() - this.lastEdit < MIN_EDIT_INTERVAL_MS) {
      this.scheduleFlush();
      return;
    }
    this.lastEdit = Date.now();

    const chunks = this.chunkRaw(this.buffer);
    for (let i = 0; i < chunks.length; i++) {
      const raw = chunks[i] ?? "";
      if (format) {
        const f = safeFormat(raw);
        await this.editOrSend(i, f ?? raw, f ? "MarkdownV2" : undefined, raw);
      } else {
        await this.editOrSend(i, raw, undefined, raw);
      }
    }
  }
}
