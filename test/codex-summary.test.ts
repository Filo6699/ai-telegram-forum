import assert from "node:assert/strict";
import test from "node:test";
import { compactCodexLimits } from "../src/codex-summary.ts";
import { parseCodexSessionUsage } from "../src/codex-session-usage.ts";
import { fmtTokens } from "../src/fmt.ts";

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
  assert.match(text!, /^week 2% ↻ 1h 29m|^week 2% ↻ 1h 30m/);
  assert.doesNotMatch(text!, /Spark/);
});

test("large token counts use millions instead of thousands", () => {
  assert.equal(fmtTokens(11_088_400), "11.1m");
});
