import assert from "node:assert/strict";
import test from "node:test";
import { CodexTurnPlan } from "../src/codex-plan.ts";

test("Codex plan posts once and records each step's first completion time", () => {
  const plan = new CodexTurnPlan(0);
  assert.equal(plan.update([], 0), null);
  assert.equal(
    plan.update([
      { step: "Inspect", status: "inProgress" },
      { step: "Fix", status: "pending" },
    ], 60_000),
    "📋 План\n- 🔄 Inspect\n- ⬜ Fix",
  );
  assert.equal(
    plan.update([
      { step: "Inspect", status: "completed" },
      { step: "Fix", status: "inProgress" },
    ], 180_000),
    null,
  );
  plan.update([
    { step: "Inspect", status: "completed" },
    { step: "Fix", status: "completed" },
  ], 420_000);
  assert.equal(
    plan.finalText(),
    "📋 План (итог; время от начала хода)\n- ✅ Inspect — 3:00\n- ✅ Fix — 7:00",
  );
});

test("Codex plan retains original steps and shows unfinished work", () => {
  const plan = new CodexTurnPlan(0);
  plan.update([{ step: "Original", status: "completed" }], 120_000);
  plan.update([{ step: "Extra", status: "inProgress" }], 240_000);
  assert.equal(
    plan.finalText(),
    "📋 План (итог; время от начала хода)\n- ✅ Original — 2:00\n- 🔄 Extra",
  );
  plan.update([{ step: "Original", status: "pending" }], 300_000);
  assert.equal(
    plan.finalText(),
    "📋 План (итог; время от начала хода)\n- ⬜ Original\n- 🔄 Extra",
  );
});
