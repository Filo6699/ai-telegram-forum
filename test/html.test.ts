import assert from "node:assert/strict";
import test from "node:test";
import { toTelegramHtml } from "../src/telegram/html.ts";

test("a bare localhost URL links to 127.0.0.1 and keeps its text", () => {
  assert.equal(
    toTelegramHtml("open http://localhost:3018/a?x=1&y=2"),
    'open <a href="http://127.0.0.1:3018/a?x=1&amp;y=2">http://localhost:3018/a?x=1&amp;y=2</a>',
  );
});

test("a markdown link to localhost points its href at 127.0.0.1", () => {
  assert.equal(
    toTelegramHtml("[dashboard](http://localhost:3018/)"),
    '<a href="http://127.0.0.1:3018/">dashboard</a>',
  );
});

test("other URLs stay bare for Telegram to auto-link", () => {
  assert.equal(toTelegramHtml("see https://example.com/_a_b_"), "see https://example.com/_a_b_");
  assert.equal(toTelegramHtml("http://localhost.example.com/"), "http://localhost.example.com/");
});
