import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseSettings } from "../src/config/settings.ts";
import { buildConfig } from "../src/config/runtime.ts";
import { classify } from "../src/telegram/media.ts";
import { transcribe } from "../src/transcription/client.ts";

const local = { BOT_TOKEN: "test:token", FORUM_CHAT_ID: "-100123", ALLOWED_USER_ID: "123" };

test("transcription is off by default and reads its key from .env when enabled", () => {
  assert.equal(buildConfig(parseSettings({}), { ...local, TRANSCRIPTION_API_KEY: "k" }).transcription, undefined);
  const cfg = buildConfig(parseSettings({ TRANSCRIPTION: { enabled: true, language: "ru" } }),
    { ...local, TRANSCRIPTION_API_KEY: " k " });
  assert.deepEqual(cfg.transcription, {
    url: "https://api.groq.com/openai/v1", model: "whisper-large-v3-turbo", language: "ru", apiKey: "k",
  });
  assert.throws(() => parseSettings({ TRANSCRIPTION: { enabled: true, apiKey: "secret" } }), /Invalid config.json/);
});

test("only voice and video notes are marked as speech", () => {
  const file = { file_id: "f", file_unique_id: "u", duration: 3 };
  assert.equal((classify({ voice: file } as any) as any).speech, true);
  assert.equal((classify({ video_note: { ...file, length: 240 } } as any) as any).speech, true);
  assert.equal((classify({ audio: file } as any) as any).speech, undefined);
});

test("transcribe posts the file to an OpenAI-compatible endpoint", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-stt-"));
  const path = join(dir, "voice.oga");
  writeFileSync(path, "OggS-bytes");
  let seen: { url?: string; auth?: string; form?: FormData } = {};
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const form = await new Request("http://x", {
      method: "POST", headers: req.headers as HeadersInit, body: Buffer.concat(chunks),
    }).formData();
    seen = { url: req.url, auth: req.headers.authorization, form };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ text: "  привет  " }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const { port } = server.address() as AddressInfo;
    const text = await transcribe(
      { url: `http://127.0.0.1:${port}/v1/`, model: "m", language: "ru", apiKey: "k" }, path);
    assert.equal(text, "привет");
    assert.equal(seen.url, "/v1/audio/transcriptions");
    assert.equal(seen.auth, "Bearer k");
    assert.equal(seen.form?.get("model"), "m");
    assert.equal(seen.form?.get("language"), "ru");
    const file = seen.form?.get("file") as File;
    assert.equal(file.name, "voice.ogg");
    assert.equal(await file.text(), "OggS-bytes");
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("transcribe reports the server's error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-stt-"));
  const path = join(dir, "voice.oga");
  writeFileSync(path, "x");
  const server = createServer((_req, res) => {
    res.statusCode = 401;
    res.end("invalid api key");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const { port } = server.address() as AddressInfo;
    await assert.rejects(
      transcribe({ url: `http://127.0.0.1:${port}`, model: "m", apiKey: "" }, path),
      /HTTP 401 invalid api key/,
    );
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
