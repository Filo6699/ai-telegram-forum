import assert from "node:assert/strict";
import test from "node:test";
import { compactCodexLimits } from "../src/codex-summary.ts";
import { parseCodexSessionUsage } from "../src/codex-session-usage.ts";
import { compactMs, fmtTokens } from "../src/fmt.ts";
import { codexPresetName } from "../src/preset.ts";

test("native Codex usage reports cumulative session tokens and context occupancy", () => {
  const line = JSON.stringify({
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { total_tokens: 11_088_400 },
        last_token_usage: { total_tokens: 135_200 },
        model_context_window: 258_400,
      },
    },
  });
  assert.deepEqual(parseCodexSessionUsage(`junk\n${line}\n`), {
    totalTokens: 11_088_400,
    contextUsedPercent: 50,
  });
});

test("compact limits includes only the shared Codex bucket", () => {
  const reset = new Date(Date.now() + 90 * 60_000).toISOString();
  const text = compactCodexLimits({
    subscription: "prolite",
    windows: [
      { label: "Codex (week)", utilization: 2, resetsAt: reset },
      { label: "GPT-5.3-Codex-Spark (5h)", utilization: 10, resetsAt: reset },
    ],
  });
  assert.equal(text, "2%");
});

test("compact limits shows the most-consumed shared window", () => {
  assert.equal(
    compactCodexLimits({
      subscription: null,
      windows: [
        { label: "Codex (5h)", utilization: 17, resetsAt: null },
        { label: "Codex (week)", utilization: 4, resetsAt: null },
      ],
    }),
    "17%",
  );
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

test("summary durations use clock notation after one minute", () => {
  assert.equal(compactMs(47_000), "47s");
  assert.equal(compactMs(99_000), "1:39");
});

test("large token counts use millions instead of thousands", () => {
  assert.equal(fmtTokens(11_088_400), "11.1m");
});
