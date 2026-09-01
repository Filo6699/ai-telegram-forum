import assert from "node:assert/strict";
import test from "node:test";
import { cfg } from "../src/config.ts";
import {
  estimateCodexCredits,
  estimateCodexWeeklyPercent,
  formatCodexWeeklyPercent,
} from "../src/codex-quota.ts";
import { parseCodexSessionUsage } from "../src/codex-session-usage.ts";
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
  assert.ok(Math.abs(usage.estimatedWeeklyPercent! - 2.477777) < 0.000001);
});

test("Codex quota credits discount cached input and apply fast mode", () => {
  const usage = {
    input_tokens: 1_000_000,
    cached_input_tokens: 800_000,
    output_tokens: 100_000,
  };
  assert.equal(estimateCodexCredits(usage, "gpt-5.6-sol", null), 78);
  assert.equal(estimateCodexCredits(usage, "gpt-5.6-sol", "fast"), 195);
  assert.equal(estimateCodexWeeklyPercent(90), 1);
  assert.equal(formatCodexWeeklyPercent(0.824), "0.8%");
  assert.equal(formatCodexWeeklyPercent(0.01), "<0.1%");
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
