import { statSync } from "node:fs";
import { extname, isAbsolute, resolve } from "node:path";
import type { Api } from "grammy";
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
  const file = await api.getFile(fileId);
  if (!file.file_path) throw new Error("Telegram returned no file_path");
  const res = await fetch(
    `https://api.telegram.org/file/bot${cfg.token}/${file.file_path}`,
  );
  if (!res.ok) throw new Error(`downloading the file failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { data: buf.toString("base64"), mediaType: mediaTypeOf(mime, file.file_path) };
}

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

const humanSize = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

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
