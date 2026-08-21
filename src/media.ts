import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, join, resolve } from "node:path";
import type { Api } from "grammy";
import type { Message } from "grammy/types";
import { cfg } from "./config.ts";

/** An image handed to the agent as a content block, straight from Telegram. */
export type ImagePart = { data: string; mediaType: string };

/** The types the model accepts — anything else isn't worth downloading. */
const BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};
const SUPPORTED = new Set(Object.values(BY_EXT));

/** True for a document Telegram says is an image we can pass on. */
export const isSupportedImage = (mime: string | undefined): boolean =>
  mime !== undefined && SUPPORTED.has(mime);

function mediaTypeOf(mime: string | undefined, path: string): string {
  if (isSupportedImage(mime)) return mime!;
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const byExt = BY_EXT[ext];
  if (byExt) return byExt;
  // Telegram's own photos are always JPEG, so this is the safe default.
  return "image/jpeg";
}

/**
 * Download a Telegram file and return it base64-encoded.
 *
 * The image travels to the agent inside the user message rather than as a path
 * on disk: the session may be running anywhere, and nothing has to survive the
 * turn. The Bot API caps downloads at 20 MB, which the caller can't check
 * beforehand for photos — `getFile` fails loudly enough.
 */
export async function fetchImage(
  api: Api,
  fileId: string,
  mime?: string,
): Promise<ImagePart> {
  const { buf, filePath } = await download(api, fileId);
  return { data: buf.toString("base64"), mediaType: mediaTypeOf(mime, filePath) };
}

/** Fetch a Telegram file's bytes, plus the remote path Telegram named it by. */
async function download(api: Api, fileId: string): Promise<{ buf: Buffer; filePath: string }> {
  const file = await api.getFile(fileId);
  if (!file.file_path) throw new Error("Telegram returned no file_path");
  const res = await fetch(
    `https://api.telegram.org/file/bot${cfg.token}/${file.file_path}`,
  );
  if (!res.ok) throw new Error(`downloading the file failed: HTTP ${res.status}`);
  return { buf: Buffer.from(await res.arrayBuffer()), filePath: file.file_path };
}

/** A non-image attachment, saved where the agent can open it. */
export type DocumentPart = { path: string; name: string; size: number };

/** Keep a Telegram-supplied name from escaping the inbox directory. */
function safeName(name: string | undefined, fallback: string): string {
  const base = (name ?? "").split(/[\\/]/).pop()?.trim() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f]/g, "").slice(0, 120);
  return cleaned || fallback;
}

/**
 * Save a document Telegram sent and hand back its path.
 *
 * Anything that isn't an image can't ride inside the message the way pixels
 * do, so it lands on disk next to the bot — same machine the session runs on —
 * and the agent reads it with its own tools. Each file gets its own directory,
 * keyed by Telegram's unique id, so two `report.md`s never overwrite each
 * other and the name the user sent survives intact.
 */
export async function fetchDocument(
  api: Api,
  file: { fileId: string; uniqueId: string; name?: string; kind: string },
): Promise<DocumentPart> {
  const { buf, filePath } = await download(api, file.fileId);
  // Telegram's ids are already url-safe, but this one names a directory, so
  // nothing but the alphabet that makes one is allowed through.
  const key = file.uniqueId.replace(/[^\w-]/g, "") || "file";
  const dir = join(resolve(cfg.inboxPath), key);
  mkdirSync(dir, { recursive: true });
  // Only documents and audio carry a name; a voice note or a sticker is named
  // after what it is, keeping the extension Telegram stored it under so the
  // agent (and anything it hands the file to) can tell the format.
  const fallback = `${file.kind}${extname(filePath) || ""}`;
  const safe = safeName(file.name, safeName(fallback, "attachment"));
  const path = join(dir, safe);
  writeFileSync(path, buf);
  return { path, name: safe, size: buf.length };
}

// -------------------------------------------------------------- classifying --

/**
 * What an inbound message carries, once its attachment is recognised.
 *
 * Three fates: pixels the model can see travel inside the message; anything
 * else with bytes behind it is saved and handed over as a path; and the
 * attachments that are pure metadata — a location, a poll — are already words,
 * so words are what the agent gets.
 */
export type Inbound =
  | { as: "image"; fileId: string; mime?: string }
  | { as: "file"; fileId: string; uniqueId: string; kind: string; label: string; name?: string }
  | { as: "text"; label: string };

/** `0:07`, `3:20`, `1:04:11` — how Telegram itself writes a duration. */
function mmss(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/**
 * Read the one attachment a message carries, whatever kind it is.
 *
 * `undefined` means there is nothing here to pass on — a service message, or a
 * kind the Bot API gives a bot no way to fetch. Order matters: a venue message
 * also carries a plain `location`, and the venue is the fuller story.
 */
export function classify(msg: Message): Inbound | undefined {
  // The last photo size is the largest one Telegram kept.
  const photo = msg.photo?.at(-1);
  if (photo) return { as: "image", fileId: photo.file_id };

  const doc = msg.document;
  if (doc) {
    if (isSupportedImage(doc.mime_type)) {
      return { as: "image", fileId: doc.file_id, mime: doc.mime_type };
    }
    return {
      as: "file",
      fileId: doc.file_id,
      uniqueId: doc.file_unique_id,
      kind: "file",
      name: doc.file_name,
      label: `attached file: ${doc.file_name ?? "file"}`,
    };
  }

  // A static sticker is a WebP the model can look at. Animated (.tgs) and
  // video (.webm) ones are formats it can't, so they go over as files.
  const st = msg.sticker;
  if (st) {
    if (!st.is_animated && !st.is_video) return { as: "image", fileId: st.file_id, mime: "image/webp" };
    return {
      as: "file",
      fileId: st.file_id,
      uniqueId: st.file_unique_id,
      kind: "sticker",
      label: `sticker ${st.emoji ?? ""}`.trim(),
    };
  }

  const video = msg.video;
  if (video) {
    return {
      as: "file",
      fileId: video.file_id,
      uniqueId: video.file_unique_id,
      kind: "video",
      name: video.file_name,
      label: `video (${mmss(video.duration)}, ${video.width}×${video.height})`,
    };
  }

  const anim = msg.animation;
  if (anim) {
    return {
      as: "file",
      fileId: anim.file_id,
      uniqueId: anim.file_unique_id,
      kind: "animation",
      name: anim.file_name,
      label: `animation (${anim.width}×${anim.height})`,
    };
  }

  const round = msg.video_note;
  if (round) {
    return {
      as: "file",
      fileId: round.file_id,
      uniqueId: round.file_unique_id,
      kind: "video_note",
      label: `video note (${mmss(round.duration)})`,
    };
  }

  const audio = msg.audio;
  if (audio) {
    const titled = [audio.performer, audio.title].filter(Boolean).join(" — ");
    return {
      as: "file",
      fileId: audio.file_id,
      uniqueId: audio.file_unique_id,
      kind: "audio",
      name: audio.file_name,
      label: `audio${titled ? `: ${titled}` : ""} (${mmss(audio.duration)})`,
    };
  }

  const voice = msg.voice;
  if (voice) {
    return {
      as: "file",
      fileId: voice.file_id,
      uniqueId: voice.file_unique_id,
      kind: "voice",
      label: `voice message (${mmss(voice.duration)})`,
    };
  }

  const venue = msg.venue;
  if (venue) {
    const { location: at, title, address } = venue;
    return { as: "text", label: `venue: ${title}, ${address} (${at.latitude}, ${at.longitude})` };
  }

  const at = msg.location;
  if (at) {
    const live = at.live_period ? ", live" : "";
    return { as: "text", label: `location: ${at.latitude}, ${at.longitude}${live}` };
  }

  const who = msg.contact;
  if (who) {
    const name = [who.first_name, who.last_name].filter(Boolean).join(" ");
    return { as: "text", label: `contact: ${name} ${who.phone_number}` };
  }

  const poll = msg.poll;
  if (poll) {
    const options = poll.options.map((o) => o.text).join(" / ");
    return { as: "text", label: `poll: "${poll.question}" — ${options}` };
  }

  const dice = msg.dice;
  if (dice) return { as: "text", label: `dice ${dice.emoji} rolled ${dice.value}` };

  return undefined;
}

/**
 * True for a message Telegram generated itself — someone joining, a topic
 * being created, a pin. There is no attachment in it to miss, so it is dropped
 * without a word; anything else that `classify` can't read is worth saying so.
 */
export function isService(msg: Message): boolean {
  return SERVICE_KEYS.some((k) => msg[k] !== undefined);
}

const SERVICE_KEYS = [
  "new_chat_members",
  "left_chat_member",
  "new_chat_title",
  "new_chat_photo",
  "delete_chat_photo",
  "pinned_message",
  "forum_topic_created",
  "forum_topic_edited",
  "forum_topic_closed",
  "forum_topic_reopened",
  "general_forum_topic_hidden",
  "general_forum_topic_unhidden",
  "message_auto_delete_timer_changed",
  "migrate_to_chat_id",
  "migrate_from_chat_id",
  "successful_payment",
  "users_shared",
  "chat_shared",
  "write_access_allowed",
  "proximity_alert_triggered",
  "video_chat_scheduled",
  "video_chat_started",
  "video_chat_ended",
  "video_chat_participants_invited",
  "web_app_data",
] as const satisfies readonly (keyof Message)[];

// ---------------------------------------------------------------- outbound --

/** How Telegram should present a file the agent attached. */
export type MediaKind = "photo" | "video" | "audio" | "animation" | "document";

/** A local file, checked and classified, ready to hand to the renderer. */
export type OutgoingFile = { path: string; kind: MediaKind };

const KIND_BY_EXT: Record<string, MediaKind> = {
  jpg: "photo",
  jpeg: "photo",
  png: "photo",
  webp: "photo",
  gif: "animation",
  mp4: "video",
  mov: "video",
  webm: "video",
  mp3: "audio",
  m4a: "audio",
  ogg: "audio",
  oga: "audio",
  wav: "audio",
  flac: "audio",
};

// Bot API upload ceilings. A photo over the photo cap still goes out — as a
// document, which keeps the pixels intact instead of failing the send.
const MAX_UPLOAD = 50 * 1024 * 1024;
const MAX_PHOTO = 10 * 1024 * 1024;

export const humanSize = (bytes: number): string =>
  bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/**
 * Turn the paths the agent named into files Telegram will accept.
 *
 * Relative paths resolve against the session's cwd — the agent works in that
 * directory, so that is what it means by `out.png`. Anything unusable is
 * reported rather than thrown: the rest of the batch should still go out, and
 * the agent needs to be told what didn't.
 */
export function resolveOutgoing(
  cwd: string,
  paths: string[],
): { files: OutgoingFile[]; errors: string[] } {
  const files: OutgoingFile[] = [];
  const errors: string[] = [];

  for (const raw of paths) {
    const path = isAbsolute(raw) ? raw : resolve(cwd, raw);
    let size: number;
    try {
      const st = statSync(path);
      if (st.isDirectory()) {
        errors.push(`${raw}: is a directory`);
        continue;
      }
      size = st.size;
    } catch {
      errors.push(`${raw}: no such file`);
      continue;
    }
    if (size === 0) {
      errors.push(`${raw}: empty file`);
      continue;
    }
    if (size > MAX_UPLOAD) {
      errors.push(`${raw}: ${humanSize(size)} exceeds Telegram's ${humanSize(MAX_UPLOAD)} limit`);
      continue;
    }
    const ext = extname(path).slice(1).toLowerCase();
    let kind = KIND_BY_EXT[ext] ?? "document";
    if (kind === "photo" && size > MAX_PHOTO) kind = "document";
    files.push({ path, kind });
  }

  return { files, errors };
}
