import assert from "node:assert/strict";
import test from "node:test";
import { parseCodexPresets, parseDefaultCodexPreset } from "../src/preset-config.ts";

test("built-in Codex presets match the launcher defaults", () => {
  const presets = parseCodexPresets(undefined);
  assert.deepEqual(
    presets.map(({ name, effort, serviceTier }) => ({ name, effort, serviceTier })),
    [
      { name: "Flash", effort: "low", serviceTier: "fast" },
      { name: "Normal", effort: "medium", serviceTier: "default" },
      { name: "Decent", effort: "high", serviceTier: "default" },
    ],
  );
  assert.equal(parseDefaultCodexPreset(undefined, presets), "Decent");
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
