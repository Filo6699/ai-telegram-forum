import assert from "node:assert/strict";
import test from "node:test";
import { progressInstruction, toolcallText } from "../src/activity.ts";

test("tool visibility separates file edits from other activity", () => {
  assert.equal(toolcallText("off", "Write", {}), null);
  for (const name of ["Edit", "MultiEdit", "Write", "NotebookEdit", "apply_patch"]) {
    assert.match(toolcallText("only_file_edits", name, { path: "a.ts" })!, /a.ts/);
  }
  assert.equal(toolcallText("only_file_edits", "Shell", { command: "ls" }), null);
  assert.match(toolcallText("full", "Shell", { command: "ls" })!, /ls/);
});

test("tool inputs are bounded and cannot close the code fence", () => {
  const text = toolcallText("full", "Shell", "```" + "x".repeat(5000))!;
  assert.ok(text.length < 3200);
  assert.equal(text.match(/```/g)?.length, 2);
  assert.match(text, /truncated/);
});

test("communication levels retain final answers and forbid private reasoning", () => {
  assert.match(progressInstruction("off"), /final answer/);
  assert.match(progressInstruction("brief"), /major milestones/);
  assert.match(progressInstruction("detailed"), /Do not expose private reasoning/);
});
