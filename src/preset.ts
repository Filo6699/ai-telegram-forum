import { cfg } from "./config.ts";
import type { Effort } from "./effort.ts";
import { effortLabel } from "./effort.ts";
import type { Model } from "./model.ts";
import { asModel, modelGroup, modelLabel } from "./model.ts";
import type { PickGroup, PickValue } from "./picker.ts";
import {
  serviceTierLabel,
  type CodexPresetConfig,
  type ServiceTier,
} from "./preset-config.ts";

export interface CodexPresetChoice {
  name: string;
  model: Model;
  effort: Effort;
  serviceTier: ServiceTier;
}

export type CodexModelChoice =
  | { kind: "preset"; preset: CodexPresetChoice }
  | { kind: "model"; model: Model };

/** The configured preset represented by an exact set of turn settings. */
export function codexPresetName(
  model: Model,
  effort: Effort,
  serviceTier: ServiceTier,
  presets: CodexPresetConfig[] = cfg.codexPresets,
): string | null {
  if (!model || !effort || !serviceTier) return null;
  return (
    presets.find(
      (preset) =>
        preset.model === model &&
        preset.effort === effort &&
        preset.serviceTier === serviceTier,
    )?.name ?? null
  );
}

const presetSummary = (preset: CodexPresetChoice): string =>
  `🎛️ preset: ${preset.name} · 🤖 ${modelLabel(preset.model, cfg.codexModel, "codex")} · ` +
  `⚙️ ${effortLabel(preset.effort)} · 🚀 ${serviceTierLabel(preset.serviceTier)}`;

/** One Codex launch group; launcher `/model` or `/effort` overrides become Custom. */
export function codexPresetPicker(
  modelOverride: Model | undefined,
  effortOverride: Effort | undefined,
  serviceTierOverride: ServiceTier | undefined = undefined,
): { group: PickGroup; selected(value: PickValue): CodexPresetChoice } {
  const configured: CodexPresetChoice[] = cfg.codexPresets.map((preset: CodexPresetConfig) => ({
    ...preset,
  }));
  const hasOverride =
    modelOverride !== undefined || effortOverride !== undefined || serviceTierOverride !== undefined;
  const exactPreset = hasOverride
    ? configured.find(
        (preset) =>
          preset.model === modelOverride &&
          preset.effort === effortOverride &&
          preset.serviceTier === serviceTierOverride,
      )
    : undefined;
  const custom: CodexPresetChoice | undefined = hasOverride && !exactPreset
    ? {
        name: "Custom",
        model: modelOverride === undefined ? null : modelOverride,
        effort: effortOverride === undefined ? null : effortOverride,
        serviceTier: serviceTierOverride ?? "default",
      }
    : undefined;
  const defaultIndex = configured.findIndex((preset) => preset.name === cfg.codexDefaultPreset);
  const fallback = `preset-${defaultIndex}`;
  const exactIndex = exactPreset ? configured.indexOf(exactPreset) : -1;
  const initial = custom ? "custom" : exactIndex >= 0 ? `preset-${exactIndex}` : fallback;

  const selected = (value: PickValue): CodexPresetChoice => {
    const picked = value ?? initial;
    if (picked === "custom" && custom) return custom;
    const index = Number(/^preset-(\d+)$/.exec(picked)?.[1]);
    return configured[index] ?? configured[defaultIndex]!;
  };

  return {
    group: {
      key: "r",
      options: [
        ...(custom ? [{ value: "custom", label: custom.name }] : []),
        ...configured.map((preset, index) => ({
          value: `preset-${index}`,
          label: preset.name,
        })),
      ],
      perRow: 3,
      initial,
      fallback,
      summary: (value) => presetSummary(selected(value)),
    },
    selected,
  };
}

/**
 * `/model` for Codex offers configured presets beside individual models. They
 * are one mutually-exclusive group: a preset applies its complete settings,
 * while a model button keeps the topic's current effort and service tier.
 */
export function codexModelPicker(
  initialModel: Model,
  initialEffort: Effort,
  initialServiceTier: ServiceTier,
): { group: PickGroup; selected(value: PickValue): CodexModelChoice } {
  const configured: CodexPresetChoice[] = cfg.codexPresets.map((preset) => ({ ...preset }));
  const models = modelGroup(initialModel, "codex");
  if (initialModel && !models.options.some((option) => option.value === initialModel)) {
    models.options.unshift({
      value: initialModel,
      label: modelLabel(initialModel, cfg.codexModel, "codex"),
    });
  }
  const presetIndex = configured.findIndex(
    (preset) =>
      preset.model === initialModel &&
      preset.effort === initialEffort &&
      preset.serviceTier === initialServiceTier,
  );
  const fallback = `model:${models.fallback}`;
  const initial =
    presetIndex >= 0 ? `preset:${presetIndex}` : `model:${initialModel ?? models.fallback}`;

  const selected = (value: PickValue): CodexModelChoice => {
    const picked = value ?? initial;
    const presetMatch = /^preset:(\d+)$/.exec(picked);
    if (presetMatch) {
      const preset = configured[Number(presetMatch[1])];
      if (preset) return { kind: "preset", preset };
    }
    return { kind: "model", model: asModel(picked.replace(/^model:/, "")) };
  };

  return {
    group: {
      key: "m",
      options: [
        ...configured.map((preset, index) => ({
          value: `preset:${index}`,
          label: `🎛️ ${preset.name}`,
        })),
        ...models.options.map((option) => ({
          value: `model:${option.value}`,
          label: option.label,
        })),
      ],
      perRow: 2,
      initial,
      fallback,
      summary: (value) => {
        const choice = selected(value);
        return choice.kind === "preset"
          ? presetSummary(choice.preset)
          : `🤖 model: ${modelLabel(choice.model, cfg.codexModel, "codex")}`;
      },
    },
    selected,
  };
}
