import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";

/** Where to send audio: any server speaking OpenAI's transcription API. */
export type TranscriptionSettings = {
  url: string;
  model: string;
  language?: string;
  apiKey: string;
};

const MIME: Record<string, string> = {
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  flac: "audio/flac",
  webm: "audio/webm",
  mp4: "video/mp4",
};

/**
 * Turn a local audio or video file into text.
 *
 * The contract is OpenAI's `POST {url}/audio/transcriptions`, which Groq and
 * self-hosted Whisper servers implement too, so the backend is a config line
 * rather than code. An empty string means the server heard no speech.
 */
export async function transcribe(
  settings: TranscriptionSettings,
  path: string,
  timeoutMs = 30_000,
): Promise<string> {
  const ext = extname(path).slice(1).toLowerCase();
  // Telegram stores voice notes as `.oga`. The bytes are plain Ogg Opus, but
  // servers pick the decoder by extension and not all of them know this one.
  const name = ext === "oga" ? `${basename(path, extname(path))}.ogg` : basename(path);
  const form = new FormData();
  form.append(
    "file",
    new Blob([readFileSync(path)], { type: MIME[ext] ?? "application/octet-stream" }),
    name,
  );
  form.append("model", settings.model);
  if (settings.language) form.append("language", settings.language);
  form.append("response_format", "json");

  const res = await fetch(`${settings.url.replace(/\/+$/, "")}/audio/transcriptions`, {
    method: "POST",
    headers: settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {},
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).trim().slice(0, 300);
    throw new Error(`transcription failed: HTTP ${res.status}${detail ? ` ${detail}` : ""}`);
  }
  const data = (await res.json()) as { text?: unknown };
  if (typeof data.text !== "string") throw new Error("transcription response has no text");
  // Whisper answers silence or noise with a lone "." rather than nothing.
  const text = data.text.trim();
  return /[\p{L}\p{N}]/u.test(text) ? text : "";
}
