import { type Bot, InputFile } from "grammy";
import telegramify from "telegramify-markdown";
import { toTelegramHtml } from "./html.js";
import type { MediaKind, OutgoingFile } from "./media.js";
import { flattenTables } from "./tables.js";

const TG_LIMIT = 4096;
const RAW_CHUNK = 2800; // raw markdown per message; formatted stays under TG_LIMIT
const CAPTION_LIMIT = 1024; // Telegram's cap on a caption, formatting included
const ALBUM_MAX = 10; // media per sendMediaGroup call
const RETRY_PAD_MS = 500; // slack past Telegram's own retry_after
const SEND_WAIT_MS = 90_000; // how long a real message will wait out a rate limit
const SEND_TRIES = 3;

/**
 * Telegram rate-limits per chat, and every topic in the forum shares that one
 * budget. A 429 anywhere therefore parks *everything* until the window passes:
 * hammering on regardless is what turns one 429 into a stream of them.
 */
let gateUntil = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Milliseconds Telegram asked us to hold off, or null if this isn't a 429. */
function retryAfterMs(err: unknown): number | null {
  const secs = (err as { parameters?: { retry_after?: number } })?.parameters?.retry_after;
  if (typeof secs === "number") return secs * 1000 + RETRY_PAD_MS;
  const m = /retry after (\d+)/i.exec(String(err));
  return m ? Number(m[1]) * 1000 + RETRY_PAD_MS : null;
}

function noteLimit(ms: number): void {
  gateUntil = Math.max(gateUntil, Date.now() + ms);
  console.warn(`[render] rate-limited, holding this chat for ${Math.ceil(ms / 1000)}s`);
}

/** How long the chat is still parked; 0 when it's free. */
export const gateMs = (): number => Math.max(0, gateUntil - Date.now());

/** Wait out the current window. False means it's longer than we're willing to wait. */
async function waitGate(budgetMs: number): Promise<boolean> {
  const wait = gateMs();
  if (wait === 0) return true;
  if (wait > budgetMs) return false;
  await sleep(wait);
  return true;
}

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
 * Telegram only groups like with like: photos and videos share an album,
 * documents and audio each need their own, and an animation can't be grouped at
 * all — it travels as a document once it has company.
 */
const albumClass = (kind: MediaKind): string =>
  kind === "photo" || kind === "video" ? "visual" : kind === "audio" ? "audio" : "document";

/** Split files into runs Telegram will accept as one album each. */
function albums(files: OutgoingFile[]): OutgoingFile[][] {
  const out: OutgoingFile[][] = [];
  for (const file of files) {
    const cur = out.at(-1);
    const fits =
      cur &&
      cur.length < ALBUM_MAX &&
      albumClass(cur[0]!.kind) === albumClass(file.kind);
    if (fits) cur.push(file);
    else out.push([file]);
  }
  return out;
}

/**
 * Posts markdown into a forum topic, degrading gracefully: MarkdownV2 →
 * Telegram HTML → plain text, so a message is never lost to a formatting error.
 *
 * Two ways in. `sendText` posts immediately — that is what the agent's
 * `mcp__tg__send` tool uses, and what makes a topic feel live. `hold`/`send`
 * keep the turn's latest reply and post it at the end; that path is the
 * fallback for a turn where the agent never spoke through the tool, so a reply
 * the session recorded can't be dropped on the floor.
 */
export class TopicRenderer {
  private buffer = "";

  constructor(
    private bot: Bot,
    private chatId: number,
    private threadId: number,
  ) {}

  /**
   * Keep `text` as the turn's fallback reply, *replacing* whatever was held.
   * Only the agent's latest word is owed to the user: appending every assistant
   * message instead would post the whole between-tools commentary as one wall
   * of text the moment a turn ends without a `send`.
   */
  hold(text: string): void {
    this.buffer = text;
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
      // A 429 says nothing about the rendering: wait it out and retry the same
      // tier, rather than degrading a message that would have arrived fine.
      for (let attempt = 0; attempt < SEND_TRIES; attempt++) {
        if (!(await waitGate(SEND_WAIT_MS))) return null;
        try {
          const sent = await this.bot.api.sendMessage(this.chatId, text, {
            message_thread_id: this.threadId,
            ...(mode ? { parse_mode: mode } : {}),
          });
          return sent.message_id;
        } catch (err) {
          const wait = retryAfterMs(err);
          if (wait !== null) {
            noteLimit(wait);
            continue;
          }
          const next = mode === "MarkdownV2" ? "HTML" : mode === "HTML" ? "plain" : "nothing";
          console.warn(`[render] ${mode ?? "plain"} rejected, falling back to ${next}:`, String(err));
          break;
        }
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

  /** One upload attempt: a single file, or an album of them. Throws on refusal. */
  private async postAlbum(
    group: OutgoingFile[],
    cap: { text: string; mode: Mode } | null,
  ): Promise<number[]> {
    // InputFile is built fresh per attempt — a retry must not reuse a stream
    // the failed send already read.
    const capOpts = cap
      ? { caption: cap.text, ...(cap.mode ? { parse_mode: cap.mode } : {}) }
      : {};

    if (group.length === 1) {
      const { path, kind } = group[0]!;
      const file = new InputFile(path);
      const opts = { message_thread_id: this.threadId, ...capOpts };
      const api = this.bot.api;
      const sent =
        kind === "photo"
          ? await api.sendPhoto(this.chatId, file, opts)
          : kind === "video"
            ? await api.sendVideo(this.chatId, file, opts)
            : kind === "audio"
              ? await api.sendAudio(this.chatId, file, opts)
              : kind === "animation"
                ? await api.sendAnimation(this.chatId, file, opts)
                : await api.sendDocument(this.chatId, file, opts);
      return [sent.message_id];
    }

    const media = group.map((f, i) => ({
      // An animation only reaches an album as a document.
      type: f.kind === "animation" ? "document" : f.kind,
      media: new InputFile(f.path),
      ...(i === 0 ? capOpts : {}),
    }));
    const sent = await this.bot.api.sendMediaGroup(this.chatId, media as never, {
      message_thread_id: this.threadId,
    });
    return sent.map((m) => m.message_id);
  }

  /**
   * Post files, using `raw` as the caption on the first one when it fits.
   * Returns whether the caption made it — if not, the caller still owes the
   * user that text as its own message.
   */
  async sendMedia(
    files: OutgoingFile[],
    raw: string,
  ): Promise<{ ids: number[]; captioned: boolean; failed: OutgoingFile[] }> {
    const ids: number[] = [];
    const failed: OutgoingFile[] = [];
    let captioned = false;

    for (const group of albums(files)) {
      // Caption tiers, best first, then a last resort with no caption at all:
      // a rejected caption must not cost the user the file.
      const wantCaption = !captioned && raw.trim().length > 0;
      const caps: Array<{ text: string; mode: Mode } | null> = wantCaption
        ? tiers(flattenTables(raw))
            .filter((t): t is { text: string; mode: Mode } =>
              Boolean(t.text && t.text.length <= CAPTION_LIMIT),
            )
            .map((t) => ({ text: t.text, mode: t.mode }))
        : [];
      caps.push(null);

      let posted = false;
      for (const cap of caps) {
        try {
          ids.push(...(await this.postAlbum(group, cap)));
          if (cap) captioned = true;
          posted = true;
          break;
        } catch (err) {
          console.warn(
            `[render] upload rejected (${group.length} file(s), caption: ${cap?.mode ?? "none"}):`,
            String(err),
          );
        }
      }
      if (!posted) failed.push(...group);
    }

    return { ids, captioned, failed };
  }

  /**
   * Rewrite an earlier message. Used for the live status line, which is edited
   * many times per turn — edits don't notify, so this stays quiet.
   *
   * `waitMs` is how long the caller is willing to sit out a rate limit. The
   * live line passes 0: it is disposable, and there'll be another refresh along
   * shortly. The turn summary is the one edit worth waiting for.
   */
  async edit(messageId: number, raw: string, waitMs = 0): Promise<boolean> {
    const giveUpAt = Date.now() + waitMs;
    for (;;) {
      if (!(await waitGate(Math.max(0, giveUpAt - Date.now())))) return false;
      const done = await this.editOnce(messageId, raw);
      if (done !== "limited") return done;
      if (Date.now() >= giveUpAt) return false;
    }
  }

  /**
   * One pass down the rendering tiers. `"limited"` means Telegram is throttling
   * us — no rendering will help, so the remaining tiers are abandoned instead of
   * spending two more calls to collect two more 429s.
   */
  private async editOnce(messageId: number, raw: string): Promise<boolean | "limited"> {
    for (const { text, mode } of tiers(flattenTables(raw).slice(0, RAW_CHUNK))) {
      if (!text || (mode && text.length > TG_LIMIT)) continue;
      try {
        await this.bot.api.editMessageText(this.chatId, messageId, text, {
          ...(mode ? { parse_mode: mode } : {}),
        });
        return true;
      } catch (err) {
        const wait = retryAfterMs(err);
        if (wait !== null) {
          noteLimit(wait);
          return "limited";
        }
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
