import assert from "node:assert/strict";
import test from "node:test";
import { cfg } from "../src/config/env.ts";
import {
  matchPreset,
  parseDefaultPreset,
  parsePresets,
  upgradeLegacyPresets,
  type Preset,
} from "../src/config/presets.ts";
import { parseSettings } from "../src/config/settings.ts";
import { launchPicker, modelPicker } from "../src/telegram/presets.ts";

const PRESETS = {
  Opus: { provider: "claude", model: "claude-opus-5-5", effort: "high" },
  Quick: { provider: "codex", model: "gpt-5.6-sol", effort: "light", fast: true },
  Decent: { provider: "codex", model: "gpt-5.6-sol", effort: "high" },
  Free: { provider: "openrouter", model: "openrouter/free", routing: { allow_fallbacks: false } },
};

/** Swap the configured presets for one test. */
function withPresets(presets: Preset[], defaultPreset: string | null, run: () => void): void {
  const saved = { presets: cfg.presets, defaultPreset: cfg.defaultPreset, provider: cfg.provider };
  Object.assign(cfg, { presets, defaultPreset, provider: presets[0]?.provider ?? "claude" });
  try {
    run();
  } finally {
    Object.assign(cfg, saved);
  }
}

test("one PRESETS block resolves each entry for its own provider", () => {
  const [opus, quick, , free] = parsePresets(PRESETS);
  assert.deepEqual(opus, {
    name: "Opus",
    provider: "claude",
    settings: { model: "claude-opus-5-5", effort: "high", serviceTier: null, openrouter: null },
  });
  assert.deepEqual(quick?.settings, { model: "gpt-5.6-sol", effort: "low", serviceTier: "fast", openrouter: null });
  assert.equal(free?.settings.model, "openrouter/free");
  assert.deepEqual(free?.settings.openrouter, {
    model: "openrouter/free",
    preset: "Free",
    provider: { allow_fallbacks: false },
  });
  assert.deepEqual(parsePresets(undefined), []);
});

test("invalid presets fail during config loading", () => {
  for (const [raw, message] of [
    [{ X: { model: "gpt-5.6-sol", effort: "high" } }, /provider must be/],
    [{ X: { provider: "claude", model: "gpt-5.6-sol", effort: "high" } }, /not a valid Claude model/],
    [{ X: { provider: "claude", model: "claude-opus-5-5", effort: "minimal" } }, /effort must be/],
    [{ X: { provider: "codex", model: "gpt-5.6-sol", effort: "huge" } }, /effort must be/],
    [{ X: { provider: "openrouter", model: "not a model" } }, /not a valid OpenRouter model/],
    [{ A: PRESETS.Opus, a: PRESETS.Opus }, /two presets named/],
  ] as const) {
    assert.throws(() => parsePresets(raw as Record<string, unknown>), message);
  }
});

test("the default preset belongs to the default provider", () => {
  const presets = parsePresets(PRESETS);
  assert.equal(parseDefaultPreset(undefined, presets, "codex"), "Quick");
  assert.equal(parseDefaultPreset("decent", presets, "codex"), "Decent");
  assert.equal(parseDefaultPreset(undefined, [], "claude"), null);
  assert.throws(() => parseDefaultPreset("Opus", presets, "codex"), /is a claude preset, but PROVIDER is codex/);
  assert.throws(() => parseDefaultPreset("missing", presets, "codex"), /does not name a configured preset/);
});

test("old per-provider keys are rejected with a pointer, and the migration upgrades them", () => {
  assert.throws(() => parseSettings({ CODEX_PRESETS: {} }), /CODEX_PRESETS moved into PRESETS/);
  const upgraded = upgradeLegacyPresets({
    PROVIDER: "codex",
    CODEX_PRESETS: { Quick: { model: "gpt-5.6-sol", effort: "low" } },
    CODEX_DEFAULT_PRESET: "Quick",
    OPENROUTER_PRESETS: { Free: { model: "openrouter/free", provider: { sort: "price" } } },
  });
  assert.deepEqual(upgraded, {
    PROVIDER: "codex",
    PRESETS: {
      Quick: { provider: "codex", model: "gpt-5.6-sol", effort: "low" },
      Free: { provider: "openrouter", model: "openrouter/free", routing: { sort: "price" } },
    },
    DEFAULT_PRESET: "Quick",
  });
  assert.deepEqual(parsePresets(upgraded.PRESETS as Record<string, unknown>)[1]?.settings.openrouter?.provider, {
    sort: "price",
  });
});

test("matching settings back to a preset is per provider", () => {
  const presets = parsePresets(PRESETS);
  const settings = { model: "gpt-5.6-sol", effort: "high", serviceTier: "default", openrouter: null } as const;
  assert.equal(matchPreset(presets, "codex", settings)?.name, "Decent");
  assert.equal(matchPreset(presets, "claude", settings), undefined);
  assert.equal(
    matchPreset(presets, "openrouter", { ...settings, openrouter: { model: "x/y", preset: "Free" } })?.name,
    "Free",
  );
});

test("the launch picker offers every provider's presets and switches agent with them", () => {
  const presets = parsePresets(PRESETS);
  withPresets(presets, "Opus", () => {
    const picker = launchPicker("claude", {})!;
    assert.deepEqual(
      picker.group.options.map((option) => option.label),
      ["✳️ Opus", "⚙️ Quick", "⚙️ Decent", "🌐 Free"],
    );
    assert.equal(picker.selected(null).preset, "Opus");
    const codex = picker.selected("p1");
    assert.equal(codex.provider, "codex");
    assert.equal(codex.settings.serviceTier, "fast");
    const free = picker.selected("p3");
    assert.equal(free.provider, "openrouter");
    // A launch never shares nested objects with the config.
    assert.notEqual(free.settings.openrouter, presets[3]!.settings.openrouter);
  });
});

test("launcher overrides become Custom unless they match a preset exactly", () => {
  withPresets(parsePresets(PRESETS), "Opus", () => {
    const custom = launchPicker("claude", { model: "claude-opus-5-5", effort: "max" })!;
    assert.equal(custom.group.initial, "custom");
    assert.equal(custom.group.options[0]?.label, "✳️ Custom");
    assert.deepEqual(custom.selected(null).settings, {
      model: "claude-opus-5-5", effort: "max", serviceTier: null, openrouter: null,
    });
    const exact = launchPicker("codex", { model: "gpt-5.6-sol", effort: "high", serviceTier: "default" })!;
    assert.equal(exact.selected(null).preset, "Decent");
    // A provider picked with /provider starts on its first preset.
    assert.equal(launchPicker("codex", {})!.selected(null).preset, "Quick");
  });
  withPresets(parsePresets({ Quick: PRESETS.Quick }), "Quick", () => {
    const picker = launchPicker("claude", {})!;
    assert.equal(picker.group.options[0]?.label, "✳️ default");
    assert.equal(picker.selected(null).provider, "claude");
  });
  withPresets([], null, () => assert.equal(launchPicker("claude", {}), undefined));
});

test("/model lists the provider's own presets beside its models", () => {
  const presets = parsePresets(PRESETS);
  withPresets(presets, "Opus", () => {
    const picker = modelPicker("codex", presets[2]!.settings);
    assert.equal(picker.group.initial, "preset:1");
    assert.deepEqual(picker.selected(null), { kind: "preset", preset: presets[2] });
    const labels = picker.group.options.map((option) => option.label);
    assert.ok(labels.includes("🎛️ Quick") && !labels.includes("🎛️ Opus"));
    assert.deepEqual(picker.selected("model:gpt-6-luna"), { kind: "model", model: "gpt-6-luna" });
  });
});
