import { cfg } from "./config.ts";
import type { Effort } from "./effort.ts";
import { effortLabel } from "./effort.ts";
import type { Model } from "./model.ts";
import { modelLabel } from "./model.ts";
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

const presetSummary = (preset: CodexPresetChoice): string =>
  `🎛️ preset: ${preset.name} · 🤖 ${modelLabel(preset.model, cfg.codexModel, "codex")} · ` +
  `⚙️ ${effortLabel(preset.effort)} · 🚀 ${serviceTierLabel(preset.serviceTier)}`;

/** One Codex launch group; launcher `/model` or `/effort` overrides become Custom. */
export function codexPresetPicker(
  modelOverride: Model | undefined,
  effortOverride: Effort | undefined,
): { group: PickGroup; selected(value: PickValue): CodexPresetChoice } {
  const configured: CodexPresetChoice[] = cfg.codexPresets.map((preset: CodexPresetConfig) => ({
    ...preset,
  }));
  const hasOverride = modelOverride !== undefined || effortOverride !== undefined;
  const custom: CodexPresetChoice | undefined = hasOverride
    ? {
        name: "Custom",
        model: modelOverride === undefined ? null : modelOverride,
        effort: effortOverride === undefined ? null : effortOverride,
        serviceTier: "default",
      }
    : undefined;
  const defaultIndex = configured.findIndex((preset) => preset.name === cfg.codexDefaultPreset);
  const fallback = `preset-${defaultIndex}`;
  const initial = custom ? "custom" : fallback;

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
