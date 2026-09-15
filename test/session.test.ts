import assert from "node:assert/strict";
import test from "node:test";
import { sideTurnReady } from "../src/side-turn.ts";

test("a live first turn is ready for /btw before its session id is persisted", () => {
  assert.equal(sideTurnReady(null, true), true);
  assert.equal(sideTurnReady(null, false), false);
  assert.equal(sideTurnReady("persisted", false), true);
});
