import assert from "node:assert/strict";
import test from "node:test";
import { claudeResponseCost } from "../src/providers/claude/pricing.ts";
import { readTranscriptLine, type PricedResponse } from "../src/providers/claude/transcripts.ts";
import {
  buildSpans,
  calibrate,
  claudeWeeklyPart,
  lowerBound,
  type WeeklyCalibration,
} from "../src/providers/claude/weekly.ts";
import type { ClaudeWeeklySample } from "../src/storage/db.ts";

const H = 3600_000;
const RESET = Date.parse("2026-10-27T20:00:00Z");
const START = RESET - 7 * 24 * H;
const sample = (h: number, utilization: number, local_usd: number, plan: string | null = "max"): ClaudeWeeklySample => ({
  at: START + h * H,
  resets_at: RESET + 500,
  utilization,
  local_usd,
  plan,
});

test("Claude response cost prices cache tiers and fast mode", () => {
  const usage = {
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    cache_read_input_tokens: 1_000_000,
    cache_creation_input_tokens: 2_000_000,
    cache_creation: { ephemeral_1h_input_tokens: 1_000_000, ephemeral_5m_input_tokens: 1_000_000 },
  };
  // 4 + 20 + 0.2 + 4*1.25 + 4*2
  assert.equal(claudeResponseCost(usage, "claude-opus-5-5"), 37.2);
  assert.equal(claudeResponseCost({ ...usage, speed: "fast" }, "claude-opus-5-5"), 74.4);
  assert.equal(claudeResponseCost({ output_tokens: 1_000_000 }, "claude-fable-5-1[1m]"), 50);
  assert.equal(claudeResponseCost({ cache_read_input_tokens: 1_000_000 }, "claude-fable-5"), 1);
  assert.equal(claudeResponseCost({ output_tokens: 1 }, "gpt-5"), null);
});

test("transcript lines repeating one message id count once, with the fullest usage", () => {
  const into = new Map<string, PricedResponse & { output: number }>();
  const line = (output: number) =>
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-10-25T10:00:00Z",
      message: { id: "msg_1", model: "claude-sonnet-5-5", usage: { output_tokens: output } },
    });
  readTranscriptLine(line(10), into);
  readTranscriptLine(line(1_000_000), into);
  readTranscriptLine(line(10), into);
  readTranscriptLine(
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-10-25T10:00:00Z",
      message: { id: "x", model: "<synthetic>", usage: { output_tokens: 5 } },
    }),
    into,
  );
  assert.equal(into.size, 1);
  assert.equal(into.get("msg_1")!.cost, 10);
});

test("spans need ten points and start from the window's zero anchor", () => {
  const spans = buildSpans([sample(10, 4, 40), sample(20, 12, 120), sample(30, 18, 180), sample(40, 23, 230)], "max");
  assert.deepEqual(spans.map((s) => [s.points, s.usd]), [[12, 120], [11, 110]]);
});

test("spans skip other plans, resets and usage the bot never saw", () => {
  const spans = buildSpans(
    [
      sample(5, 15, 150, "pro"),
      sample(10, 10, 100),
      // Percent jumped with no local spend: another device. Dropped.
      sample(11, 30, 100),
      // Percent fell: window re-based. Start over from here.
      sample(12, 2, 120),
      sample(20, 12, 220),
    ],
    "max",
  );
  assert.deepEqual(spans.map((s) => [s.points, s.usd]), [[10, 100], [10, 100]]);
});

test("calibration takes an upper quantile, so hidden usage cannot drag it down", () => {
  const spans = [10, 10, 10, 2].map((perPoint, i) => ({ end: i + 1, points: 10, usd: perPoint * 10 }));
  const c = calibrate(spans, "max", null)!;
  assert.equal(c.usdPerPercent, 10);
});

test("calibration moves at most 25% per new span and ignores spans it already used", () => {
  const prev: WeeklyCalibration = { usdPerPercent: 10, plan: "max", lastSpanEnd: 1, points: 10, spans: 1 };
  const spike = [{ end: 1, points: 10, usd: 100 }, { end: 2, points: 10, usd: 1000 }];
  assert.equal(calibrate(spike, "max", prev)!.usdPerPercent, 12.5);
  assert.equal(calibrate(spike.slice(0, 1), "max", prev), prev);
  const drop = [{ end: 2, points: 10, usd: 1 }];
  assert.equal(calibrate(drop, "max", prev)!.usdPerPercent, 8);
});

test("no estimate until calibrated, and none carried across a plan change", () => {
  assert.equal(calibrate([], "max", null), null);
  const prev: WeeklyCalibration = { usdPerPercent: 10, plan: "pro", lastSpanEnd: 1, points: 10, spans: 1 };
  assert.equal(calibrate([], "max", prev), null);
  assert.equal(claudeWeeklyPart(5, 0, null), null);
  const cal = { usdPerPercent: 10, calibrated: true };
  assert.equal(claudeWeeklyPart(5, 4, cal), "🧠 0.1% | 0.5%");
  assert.equal(claudeWeeklyPart(5, null, cal), "🧠 0.5%");
  assert.equal(claudeWeeklyPart(5, 4, { usdPerPercent: 10, calibrated: false }), "🧠 0.1% | 0.5%");
});

test("the floor holds whatever other devices spent, and only grows", () => {
  // Rounded 2% means under 2.5%: 15 local dollars give at least $6 per 1%.
  assert.equal(lowerBound([sample(1, 2, 15)], "max"), 6);
  // Hidden usage pushes the percent up, which only weakens a sample's floor.
  assert.equal(lowerBound([sample(1, 2, 15), sample(2, 9, 16)], "max"), 6);
  assert.equal(lowerBound([sample(1, 2, 15), sample(2, 3, 35)], "max"), 10);
  assert.equal(lowerBound([sample(1, 2, 15, "pro")], "max"), null);
  assert.equal(lowerBound([], "max"), null);
});
