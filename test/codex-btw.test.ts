import assert from "node:assert/strict";
import test from "node:test";
import { codexSideBoundaryItem, codexSideForkParams } from "../src/codex.ts";
import { TopicRenderer } from "../src/render.ts";

test("Codex /btw uses an ephemeral metadata-only fork with Telegram disabled", () => {
  const params = codexSideForkParams({
    parentId: "parent",
    threadId: 42,
    cwd: "/tmp/project",
    effort: "high",
    model: "gpt-test",
    serviceTier: "fast",
  }) as any;

  assert.equal(params.threadId, "parent");
  assert.equal(params.ephemeral, true);
  assert.equal(params.excludeTurns, true);
  assert.equal(params.config.mcp_servers.tg.enabled, false);
  assert.equal(params.config.mcp_servers.tg.required, false);
  assert.match(params.developerInstructions, /Do not call mcp__tg__send/);
  assert.match(codexSideBoundaryItem().content[0]!.text, /inherited history/);
});

test("a side answer and its status remain in one direct Telegram reply", async () => {
  const sent: any[] = [];
  const edited: any[] = [];
  const api = {
    async sendMessage(_chatId: number, text: string, options: any) {
      sent.push({ text, options });
      return { message_id: 100 + sent.length };
    },
    async editMessageText(_chatId: number, messageId: number, text: string, options: any) {
      edited.push({ messageId, text, options });
      return true;
    },
  };
  const out = new TopicRenderer(api as any, -100, 7, { replyToMessageId: 99 });

  const placeholder = await out.sendText("⏳ …", { silent: true });
  await out.replaceWithAnswer(placeholder!, "The answer", "✅ 2s · Decent");

  assert.equal(sent.length, 1);
  assert.equal(sent[0].options.reply_parameters.message_id, 99);
  assert.equal(sent[0].options.disable_notification, true);
  assert.equal(edited.length, 1);
  assert.match(edited[0].text, /The answer/);
  assert.match(edited[0].text, /✅ 2s/);
});
