import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "grammy/types";
import { richText } from "../src/telegram/rich.ts";

const message = (rich_message: unknown) => ({ rich_message }) as unknown as Message;

test("plain and caption messages have no rich text", () => {
  assert.equal(richText({ text: "hi" } as Message), undefined);
});

test("renders a rich message back into Markdown", () => {
  const text = richText(message({
    blocks: [
      { type: "heading", size: 2, text: "Restore" },
      { type: "paragraph", text: ["Run ", { type: "code", text: "dumpctl.py" }, " with ", { type: "bold", text: "care" }, "."] },
      { type: "pre", language: "bash", text: "python3 client/dumpctl.py restore \\\n  --port 55432" },
      { type: "list", items: [
        { label: "1.", blocks: [{ type: "paragraph", text: "first" }] },
        { label: "2.", has_checkbox: true, is_checked: true, blocks: [{ type: "paragraph", text: "done" }] },
      ] },
      { type: "blockquote", blocks: [{ type: "paragraph", text: "quoted" }] },
      { type: "table", cells: [
        [{ text: "a", is_header: true, align: "left", valign: "top" }, { text: "b", is_header: true, align: "left", valign: "top" }],
        [{ text: "1", align: "left", valign: "top" }, { text: "2", align: "left", valign: "top" }],
      ] },
      { type: "photo", photo: [], caption: { text: "diagram" } },
      { type: "paragraph", text: [{ type: "url", text: "docs", url: "https://example.com" }, " ", { type: "custom_emoji", custom_emoji_id: "1", alternative_text: "🔥" }] },
    ],
  }));
  assert.equal(text, [
    "## Restore",
    "Run `dumpctl.py` with **care**.",
    "```bash\npython3 client/dumpctl.py restore \\\n  --port 55432\n```",
    "1. first\n2. [x] done",
    "> quoted",
    "| a | b |\n| --- | --- |\n| 1 | 2 |",
    "[embedded photo, not downloaded]\ndiagram",
    "[docs](https://example.com) 🔥",
  ].join("\n\n"));
});

test("unknown block and text kinds fall back to their words", () => {
  const text = richText(message({
    blocks: [
      { type: "future_block", text: [{ type: "future_style", text: "kept" }] },
      { type: "future_container", blocks: [{ type: "paragraph", text: "nested" }] },
    ],
  }));
  assert.equal(text, "kept\n\nnested");
});
