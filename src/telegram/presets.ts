import { cfg } from "../config/env.ts";
import { effortLabel } from "../config/effort.ts";
import { asModel, defaultModel, modelGroup, modelLabel, type Model } from "../config/model.ts";
import {
  cloneSettings,
  matchPreset,
  type ModelSettings,
  type Preset,
} from "../config/presets.ts";
import { providerLabel, type Provider } from "../config/provider.ts";
import { serviceTierLabel } from "../config/service-tier.ts";
import type { PickGroup, PickValue } from "./picker.ts";

/** What a launch starts: the agent, its settings, and the preset they came from. */
export interface LaunchChoice {
  provider: Provider;
  settings: ModelSettings;
  preset: string | null;
}

export type ModelChoice = { kind: "preset"; preset: Preset } | { kind: "model"; model: Model };

const ICONS: Record<Provider, string> = { claude: "✳️", codex: "⚙️", openrouter: "🌐" };

export const providerIcon = (provider: Provider): string => ICONS[provider];

export const presetsFor = (provider: Provider): Preset[] =>
  cfg.presets.filter((preset) => preset.provider === provider);

/** The configured preset an exact set of settings came from. */
export const presetName = (provider: Provider, settings: ModelSettings): string | null =>
  matchPreset(cfg.presets, provider, settings)?.name ?? null;

/** The preset a launch on `provider` starts with when nothing was picked. */
function defaultPresetFor(provider: Provider): Preset | undefined {
  const own = presetsFor(provider);
  return own.find((preset) => preset.name === cfg.defaultPreset) ?? own[0];
}

/** Model, effort and mode as one line; each provider shows what it has. */
export function settingsLine(provider: Provider, settings: ModelSettings): string {
  const parts = [`🤖 ${modelLabel(settings.model, defaultModel(provider), provider)}`];
  if (provider !== "openrouter") parts.push(`⚙️ ${effortLabel(settings.effort)}`);
  if (provider === "codex") parts.push(`🚀 ${serviceTierLabel(settings.serviceTier)}`);
  return parts.join(" · ");
}

const presetSummary = (preset: Preset): string =>
  `🎛️ preset: ${preset.name} · ${providerIcon(preset.provider)} ${providerLabel(preset.provider)} · ` +
  settingsLine(preset.provider, preset.settings);

const presetChoice = (preset: Preset): LaunchChoice => ({
  provider: preset.provider,
  settings: cloneSettings(preset.settings),
  preset: preset.name,
});

/**
 * Launcher `/model` and `/effort` choices as complete settings. Anything left
 * unset stays `null`, which each provider resolves to its own default.
 */
function customSettings(provider: Provider, overrides: Partial<ModelSettings>): ModelSettings {
  const model = overrides.model ?? null;
  if (provider === "openrouter") {
    const openrouter = overrides.openrouter ?? (model ? { model } : null);
    return { model: openrouter?.model ?? null, effort: null, serviceTier: null, openrouter };
  }
  return {
    model,
    effort: overrides.effort ?? null,
    serviceTier: provider === "codex" ? (overrides.serviceTier ?? "default") : null,
    openrouter: null,
  };
}

/**
 * One launch group holding every configured preset, whatever its provider.
 * Picking a preset of another provider switches the agent for the topic about
 * to be created. A "Custom" button stands for launcher `/model` and `/effort`
 * choices that match no preset, or for the provider's own defaults when it has
 * no presets. Without any presets there is nothing to offer: `undefined`.
 */
export function launchPicker(
  provider: Provider,
  overrides: Partial<ModelSettings>,
): { group: PickGroup; selected(value: PickValue): LaunchChoice } | undefined {
  const presets = cfg.presets;
  if (!presets.length) return undefined;

  const hasOverride = Object.values(overrides).some((value) => value !== undefined);
  const custom: LaunchChoice = {
    provider,
    settings: customSettings(provider, overrides),
    preset: null,
  };
  const start = hasOverride ? matchPreset(presets, provider, custom.settings) : defaultPresetFor(provider);
  const initial = start ? `p${presets.indexOf(start)}` : "custom";

  const selected = (value: PickValue): LaunchChoice => {
    const picked = value ?? initial;
    const preset = presets[Number(/^p(\d+)$/.exec(picked)?.[1])];
    return preset ? presetChoice(preset) : custom;
  };

  return {
    group: {
      key: "r",
      options: [
        ...(start
          ? []
          : [{ value: "custom", label: `${providerIcon(provider)} ${hasOverride ? "Custom" : "default"}` }]),
        ...presets.map((preset, index) => ({
          value: `p${index}`,
          label: `${providerIcon(preset.provider)} ${preset.name}`,
        })),
      ],
      perRow: 3,
      initial,
      fallback: initial,
      summary: (value) => {
        const choice = selected(value);
        const preset = choice.preset ? presets.find((item) => item.name === choice.preset) : undefined;
        return preset
          ? presetSummary(preset)
          : `${providerIcon(provider)} ${providerLabel(provider)} · ${settingsLine(provider, choice.settings)}`;
      },
    },
    selected,
  };
}

/**
 * `/model` offers the provider's presets beside its individual models, as one
 * mutually-exclusive group: a preset applies its complete settings, while a
 * model button keeps the current effort and mode.
 */
export function modelPicker(
  provider: Provider,
  current: ModelSettings,
): { group: PickGroup; selected(value: PickValue): ModelChoice } {
  const presets = presetsFor(provider);
  const models = modelGroup(current.model, provider);
  if (current.model && !models.options.some((option) => option.value === current.model)) {
    models.options.unshift({
      value: current.model,
      label: modelLabel(current.model, defaultModel(provider), provider),
    });
  }
  const match = matchPreset(presets, provider, current);
  const fallback = `model:${models.fallback}`;
  const initial = match
    ? `preset:${presets.indexOf(match)}`
    : `model:${current.model ?? models.fallback}`;

  const selected = (value: PickValue): ModelChoice => {
    const picked = value ?? initial;
    const preset = presets[Number(/^preset:(\d+)$/.exec(picked)?.[1])];
    if (preset) return { kind: "preset", preset };
    return { kind: "model", model: asModel(picked.replace(/^model:/, "")) };
  };

  return {
    group: {
      key: "m",
      options: [
        ...presets.map((preset, index) => ({ value: `preset:${index}`, label: `🎛️ ${preset.name}` })),
        ...models.options.map((option) => ({ value: `model:${option.value}`, label: option.label })),
      ],
      perRow: 2,
      initial,
      fallback,
      summary: (value) => {
        const choice = selected(value);
        return choice.kind === "preset"
          ? presetSummary(choice.preset)
          : `🤖 model: ${modelLabel(choice.model, defaultModel(provider), provider)}`;
      },
    },
    selected,
  };
}
