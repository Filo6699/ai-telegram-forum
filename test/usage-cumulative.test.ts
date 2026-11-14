import assert from "node:assert/strict";
import test from "node:test";
import { addUsage, createTopic, getTopic } from "../src/storage/db.ts";

const cum = (inTokens: number, outTokens: number, costUsd: number) =>
  ({ inTokens, outTokens, costUsd, cumulative: true });

test("claude running totals are stored as per-turn deltas", () => {
  createTopic({ threadId: 9001, cwd: "/tmp", title: "t" });
  addUsage(9001, cum(100, 10, 1));
  addUsage(9001, cum(250, 30, 2.5));
  let t = getTopic(9001)!;
  assert.equal(t.turns, 2);
  assert.equal(t.in_tokens, 250);
  assert.equal(t.out_tokens, 30);
  assert.equal(t.cost_usd, 2.5);

  addUsage(9001, cum(40, 5, 0.5));
  t = getTopic(9001)!;
  assert.equal(t.in_tokens, 290);
  assert.equal(t.cost_usd, 3);

  addUsage(9001, cum(0, 0, 0));
  t = getTopic(9001)!;
  assert.equal(t.turns, 4);
  assert.equal(t.in_tokens, 290);
});
