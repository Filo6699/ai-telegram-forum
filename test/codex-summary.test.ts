import assert from "node:assert/strict";
import test from "node:test";
import { cfg } from "../src/config.ts";
import {
  estimateCodexCredits,
  estimateCodexWeeklyPercent,
  formatCodexWeeklyPercent,
} from "../src/codex-quota.ts";
import {
  mergeCodexSessionUsage,
  parseCodexRollout,
  parseCodexSessionUsage,
} from "../src/codex-session-usage.ts";
import { formatCodexWeeklyPart } from "../src/codex-summary.ts";
import { compactMs, fmtTokens } from "../src/fmt.ts";
import { codexModelPicker, codexPresetName } from "../src/preset.ts";
import { asServiceTier, serviceTierGroup } from "../src/preset-config.ts";

test("native Codex usage aggregates every response and estimates weekly session spend", () => {
  const lines = [
    JSON.stringify({
      type: "turn_context",
      payload: { model: "gpt-5.6-sol", service_tier: null },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { total_tokens: 1_100_000 },
          last_token_usage: {
            input_tokens: 1_000_000,
            cached_input_tokens: 800_000,
            output_tokens: 100_000,
            total_tokens: 1_100_000,
          },
          model_context_window: 258_400,
        },
      },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { total_tokens: 2_300_000 },
          last_token_usage: {
            input_tokens: 1_800_000,
            cached_input_tokens: 1_500_000,
            output_tokens: 200_000,
            total_tokens: 2_000_000,
          },
          model_context_window: 258_400,
        },
      },
    }),
  ];
  const usage = parseCodexSessionUsage(`junk\n${lines.join("\n")}\n`);
  assert.ok(usage);
  assert.equal(usage.totalTokens, 3_100_000);
  assert.equal(usage.contextUsedPercent, 100);
  assert.ok(Math.abs(usage.estimatedWeeklyPercent! - 2.623529) < 0.000001);
});

test("Codex rollout usage discovers child-agent threads and merges their spend", () => {
  const parent = parseCodexRollout(
    [
      JSON.stringify({
        type: "turn_context",
        payload: { model: "gpt-5.6-sol", service_tier: null },
      }),
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 100_000,
              cached_input_tokens: 50_000,
              output_tokens: 10_000,
              total_tokens: 110_000,
            },
            model_context_window: 258_400,
          },
        },
      }),
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "item_completed",
          item: {
            type: "CollabAgentToolCall",
            receiver_thread_ids: ["child-1", "child-2"],
          },
        },
      }),
    ].join("\n"),
  );
  const child = parseCodexSessionUsage(
    [
      JSON.stringify({
        type: "turn_context",
        payload: { model: "gpt-5.6-sol", service_tier: null },
      }),
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 200_000,
              cached_input_tokens: 100_000,
              output_tokens: 20_000,
              total_tokens: 220_000,
            },
          },
        },
      }),
    ].join("\n"),
  );

  assert.deepEqual(parent.childThreadIds, ["child-1", "child-2"]);
  assert.ok(parent.usage);
  assert.ok(child);
  const merged = mergeCodexSessionUsage([parent.usage, child]);
  assert.equal(merged?.totalTokens, 330_000);
  assert.equal(merged?.contextUsedPercent, parent.usage.contextUsedPercent);
  assert.equal(
    merged?.estimatedWeeklyPercent,
    parent.usage.estimatedWeeklyPercent! + child.estimatedWeeklyPercent!,
  );
});

test("Codex quota credits discount cached input and apply fast mode", () => {
  const usage = {
    input_tokens: 1_000_000,
    cached_input_tokens: 800_000,
    output_tokens: 100_000,
  };
  assert.equal(estimateCodexCredits(usage, "gpt-5.6-sol", null), 78);
  assert.equal(estimateCodexCredits(usage, "gpt-5.6-sol", "fast"), 195);
  assert.equal(estimateCodexCredits(usage, "gpt-6-sol", null), 39);
  assert.equal(estimateCodexCredits(usage, "gpt-6-sol", "fast"), 97.5);
  assert.equal(estimateCodexCredits(usage, "gpt-6-luna", null), 1.95);
  assert.equal(estimateCodexCredits(usage, "gpt-6-luna", "fast"), 4.875);
  assert.equal(estimateCodexCredits(usage, "gpt-5.4", "fast"), null);
  assert.equal(estimateCodexWeeklyPercent(85), 1);
  assert.equal(formatCodexWeeklyPercent(0.824), "0.8%");
  assert.equal(formatCodexWeeklyPercent(0.01), "0.01%");
  assert.equal(formatCodexWeeklyPercent(0.02), "0.02%");
});

test("Codex rollout prices each turn at its persisted tier when native tier is absent", () => {
  const lines = [
    { type: "turn_context", payload: { turn_id: "standard-turn", model: "gpt-6-sol" } },
    {
      type: "event_msg",
      payload: { type: "token_count", info: { last_token_usage: { input_tokens: 1_000_000 } } },
    },
    { type: "turn_context", payload: { turn_id: "fast-turn", model: "gpt-6-sol" } },
    {
      type: "event_msg",
      payload: { type: "token_count", info: { last_token_usage: { input_tokens: 1_000_000 } } },
    },
  ].map((line) => JSON.stringify(line)).join("\n");
  const parsed = parseCodexRollout(lines, {
    turnTiers: new Map([["standard-turn", "default"], ["fast-turn", "fast"]]),
  });

  assert.equal(parsed.usage?.estimatedWeeklyPercent, estimateCodexWeeklyPercent(175));
  assert.deepEqual(parsed.untrackedTurnIds, []);
});

test("old Codex turns use the topic tier and pass it to child agents", () => {
  const lines = [
    { type: "turn_context", payload: { turn_id: "old-turn", model: "gpt-6-luna" } },
    {
      type: "event_msg",
      payload: { type: "token_count", info: { last_token_usage: { input_tokens: 1_000_000 } } },
    },
    {
      type: "event_msg",
      payload: { type: "item_completed", item: { type: "CollabAgentToolCall", receiver_thread_ids: ["child"] } },
    },
  ].map((line) => JSON.stringify(line)).join("\n");
  const parsed = parseCodexRollout(lines, { fallbackTier: "fast" });

  assert.equal(parsed.usage?.estimatedWeeklyPercent, estimateCodexWeeklyPercent(6.25));
  assert.deepEqual(parsed.untrackedTurnIds, ["old-turn"]);
  assert.equal(parsed.childServiceTiers.get("child"), "fast");
});

test("Codex's native priority tier is treated as fast", () => {
  const lines = [
    { type: "turn_context", payload: { turn_id: "priority-turn", model: "gpt-6-luna", service_tier: "priority" } },
    {
      type: "event_msg",
      payload: { type: "token_count", info: { last_token_usage: { input_tokens: 1_000_000 } } },
    },
  ].map((line) => JSON.stringify(line)).join("\n");
  const parsed = parseCodexRollout(lines);

  assert.equal(parsed.usage?.estimatedWeeklyPercent, estimateCodexWeeklyPercent(6.25));
  assert.deepEqual(parsed.untrackedTurnIds, []);
});

test("an explicit native null tier stays standard even with a fast topic fallback", () => {
  const lines = [
    { type: "turn_context", payload: { turn_id: "standard-turn", model: "gpt-6-luna", service_tier: null } },
    {
      type: "event_msg",
      payload: { type: "token_count", info: { last_token_usage: { input_tokens: 1_000_000 } } },
    },
  ].map((line) => JSON.stringify(line)).join("\n");
  const parsed = parseCodexRollout(lines, { fallbackTier: "fast" });

  assert.equal(parsed.usage?.estimatedWeeklyPercent, estimateCodexWeeklyPercent(2.5));
  assert.deepEqual(parsed.untrackedTurnIds, []);
});

test("Codex weekly summary shows this turn before the cumulative session", async () => {
  assert.equal(formatCodexWeeklyPart(2.2, 1.8), "🧠 0.4% | 2.2%");
  assert.equal(formatCodexWeeklyPart(2.2), "🧠 2.2%");
});

test("an exact Codex setting tuple collapses to its preset name", () => {
  assert.equal(
    codexPresetName("gpt-5.6-sol", "high", "default", [
      { name: "Decent", model: "gpt-5.6-sol", effort: "high", serviceTier: "default" },
    ]),
    "Decent",
  );
  assert.equal(codexPresetName("gpt-5.6-sol", "low", "default", []), null);
});

test("Codex model picker exposes and selects configured presets", () => {
  const preset = cfg.codexPresets[0]!;
  const picker = codexModelPicker(preset.model, preset.effort, preset.serviceTier);

  assert.equal(picker.group.initial, "preset:0");
  assert.deepEqual(picker.selected(null), { kind: "preset", preset });
  assert.ok(picker.group.options.some((option) => option.label === `🎛️ ${preset.name}`));
});

test("the no-preset Codex launch picker exposes standard and fast modes", () => {
  const group = serviceTierGroup(null);

  assert.equal(group.fallback, "default");
  assert.deepEqual(group.options.map((option) => option.value), ["default", "fast"]);
  assert.equal(asServiceTier("fast"), "fast");
  assert.equal(group.summary("fast"), "🚀 mode: fast");
});

test("summary durations use clock notation after one minute", () => {
  assert.equal(compactMs(47_000), "47s");
  assert.equal(compactMs(99_000), "1:39");
});

test("large token counts use millions instead of thousands", () => {
  assert.equal(fmtTokens(11_088_400), "11.1m");
});
