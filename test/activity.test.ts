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

test("Codex command items show one short command without app-server metadata", () => {
  const text = toolcallText("full", "Shell", {
    type: "commandExecution",
    id: "exec-123",
    command: "git status --short",
    cwd: "/home/project",
    commandActions: [{ command: "git status --short" }],
    status: "inProgress",
  });
  assert.equal(text, "🔧 Shell: git status --short");
});

test("tool messages remain short and show paths for file changes", () => {
  const text = toolcallText("full", "Shell", "x".repeat(5000))!;
  assert.ok(text.length < 220);
  assert.ok(text.endsWith("…"));
  assert.equal(toolcallText("only_file_edits", "apply_patch", {
    changes: [{ path: "src/activity.ts" }, { path: "test/activity.test.ts" }],
  }), "🔧 apply_patch: src/activity.ts, test/activity.test.ts");
  assert.equal(toolcallText("full", "mcp__example__tool", { id: "123", status: "started" }), "🔧 mcp__example__tool");
});

test("communication levels retain final answers and forbid private reasoning", () => {
  assert.match(progressInstruction("off"), /final answer/);
  assert.match(progressInstruction("brief"), /major milestones/);
  assert.match(progressInstruction("detailed"), /Do not expose private reasoning/);
});
