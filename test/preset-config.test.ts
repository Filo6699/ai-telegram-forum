import assert from "node:assert/strict";
import test from "node:test";
import { parseCodexPresets, parseDefaultCodexPreset } from "../src/preset-config.ts";

test("Codex has no built-in presets", () => {
  const presets = parseCodexPresets(undefined);
  assert.deepEqual(presets, []);
  assert.equal(parseDefaultCodexPreset(undefined, presets), null);
  assert.throws(
    () => parseDefaultCodexPreset("Decent", presets),
    /requires at least one configured CODEX_PRESETS entry/,
  );
});

test("custom presets preserve labels and accept light as low", () => {
  const presets = parseCodexPresets(
    JSON.stringify({ Quick: { model: "gpt-5.6-sol", effort: "light", fast: true } }),
  );
  assert.deepEqual(presets, [
    { name: "Quick", model: "gpt-5.6-sol", effort: "low", serviceTier: "fast" },
  ]);
  assert.equal(parseDefaultCodexPreset("quick", presets), "Quick");
});

test("invalid preset effort fails during config loading", () => {
  assert.throws(
    () => parseCodexPresets('{"Oops":{"model":"gpt-5.6-sol","effort":"huge"}}'),
    /effort must be/,
  );
});
