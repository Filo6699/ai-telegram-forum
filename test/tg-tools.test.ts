import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TopicRenderer } from "../src/telegram/render.ts";
import { createTgChannel, runTgSend, tgSendDelivered } from "../src/telegram/tg-tools.ts";

function fixture(t: { after(fn: () => void): void }) {
  const cwd = mkdtempSync(join(tmpdir(), "tg-send-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, "first.png"), "image");
  writeFileSync(join(cwd, "second.png"), "image");
  writeFileSync(join(cwd, "report.pdf"), "document");
  const uploads: string[] = [];
  const messages: string[] = [];
  const api = {
    async sendMessage(_chat: number, body: string) {
      messages.push(body);
      return { message_id: 10 };
    },
    async sendPhoto() { uploads.push("photo"); return { message_id: 11 }; },
    async sendDocument() { uploads.push("document"); return { message_id: 12 }; },
    async sendMediaGroup() { uploads.push("album"); return [{ message_id: 13 }, { message_id: 14 }]; },
  };
  const out = new TopicRenderer(api as any, -100, 1);
  return { cwd, api, out, uploads, messages };
}

test("a missing attachment is an error even when a valid file is delivered", async (t) => {
  const h = fixture(t);
  const result = await runTgSend(h.out, h.cwd, { files: ["first.png", "missing.png"] });
  assert.equal("isError" in result && result.isError, true);
  assert.equal(tgSendDelivered(result), true);
  assert.match(result.content[0]!.text, /sent \(1 file\(s\)/);
  assert.match(result.content[0]!.text, /missing.png: no such file/);
  assert.match(result.content[0]!.text, /Tell the user immediately[\s\S]*Do not split/);
  assert.deepEqual(h.uploads, ["photo"]);
});

test("a rejected upload is an error when its caption was sent separately", async (t) => {
  const h = fixture(t);
  h.api.sendPhoto = async () => { throw new Error("upload rejected"); };
  const result = await runTgSend(h.out, h.cwd, { text: "Here is the image", files: ["first.png"] });
  assert.equal("isError" in result && result.isError, true);
  assert.equal(tgSendDelivered(result), true);
  assert.match(result.content[0]!.text, /sent \(0 file\(s\)/);
  assert.match(result.content[0]!.text, /first.png: upload rejected/);
  assert.match(result.content[0]!.text, /Tell the user immediately/);
  assert.equal(h.messages.length, 1);
});

test("a rejected album reports every file without splitting it into individual uploads", async (t) => {
  const h = fixture(t);
  h.api.sendMediaGroup = async () => { h.uploads.push("album"); throw new Error("album rejected"); };
  const result = await runTgSend(h.out, h.cwd, { files: ["first.png", "second.png", "missing.png"] });
  assert.equal("isError" in result && result.isError, true);
  assert.equal(tgSendDelivered(result), false);
  for (const name of ["first.png", "second.png", "missing.png"]) assert.ok(result.content[0]!.text.includes(name));
  assert.match(result.content[0]!.text, /Do not split/);
  assert.deepEqual(h.uploads, ["album"]);
  assert.deepEqual(h.messages, []);
});

test("partial delivery counts as speech so the final-text fallback is not duplicated", async (t) => {
  const h = fixture(t);
  h.api.sendDocument = async () => { throw new Error("document rejected"); };
  const channel = createTgChannel(h.out, h.cwd);
  const result = await channel.send({ files: ["first.png", "report.pdf"] });
  assert.equal("isError" in result && result.isError, true);
  assert.equal(channel.sent, 1);
  assert.match(result.content[0]!.text, /report.pdf: upload rejected/);
  channel.resetSent();
  assert.equal(channel.sent, 0);
});

test("invalid paths preserve text delivery status without interpreting filenames as receipts", async (t) => {
  const h = fixture(t);
  const missing = "text was sent on its own";
  const unsent = await runTgSend(h.out, h.cwd, { files: [missing] });
  assert.equal(tgSendDelivered(unsent), false);
  const sent = await runTgSend(h.out, h.cwd, { text: "Explanation", files: [missing] });
  assert.equal(tgSendDelivered(sent), true);
  assert.match(sent.content[0]!.text, /no file could be attached/);
  assert.match(sent.content[0]!.text, /Tell the user immediately/);
});

test("successful attachment and text sends still return success", async (t) => {
  const h = fixture(t);
  for (const args of [{ files: ["first.png", "second.png"] }, { text: "Done" }]) {
    const result = await runTgSend(h.out, h.cwd, args);
    assert.equal("isError" in result, false);
    assert.equal(tgSendDelivered(result), true);
  }
});
