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
