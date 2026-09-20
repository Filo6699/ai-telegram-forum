import { cfg } from "./config.ts";
import type { Effort } from "./effort.ts";
import type { Model } from "./model.ts";
import {
  codexPresetPicker,
  type CodexPresetChoice,
} from "./preset.ts";
import {
  openRouterModelPicker,
  type OpenRouterModelChoice,
  type OpenRouterSettings,
} from "./openrouter-config.ts";
import type { PickGroup, PickValue } from "./picker.ts";
import type { Provider } from "./provider.ts";
import type { ServiceTier } from "./preset-config.ts";

export type LaunchPresetChoice =
  | { provider: "codex"; codex: CodexPresetChoice }
  | { provider: "openrouter"; openrouter: OpenRouterSettings };

/**
 * One launch group containing both native Codex presets and configured
 * OpenRouter presets. Choosing an OpenRouter option changes the provider for
 * the topic that is about to be created; the two providers never share a
 * running session.
 */
export function launchPresetPicker(
  provider: Provider,
  modelOverride: Model | undefined,
  effortOverride: Effort | undefined,
  serviceTierOverride: ServiceTier | undefined,
  openrouterInitial: OpenRouterSettings | null | undefined,
): { group: PickGroup; selected(value: PickValue): LaunchPresetChoice } | undefined {
  const codex = cfg.codexPresets.length
    ? codexPresetPicker(modelOverride, effortOverride, serviceTierOverride)
    : undefined;
  const openrouter = cfg.openrouterEnabled
    ? openRouterModelPicker(openrouterInitial, cfg.openrouterModel, cfg.openrouterPresets)
    : undefined;
  if (!codex && !openrouter) return undefined;

  const prefixed = (prefix: string, labelPrefix: string, group: PickGroup) =>
    group.options.map((option) => ({
      value: `${prefix}:${option.value}`,
      label: `${labelPrefix}${option.label.replace(/^🎛️\s*/, "")}`,
    }));

  const options = [
    ...(codex ? prefixed("codex", "⚙️ ", codex.group) : []),
    ...(openrouter ? prefixed("openrouter", "🌐 ", openrouter.group) : []),
  ];

  const preferred = provider === "openrouter" && openrouter ? "openrouter" : "codex";
  const preferredGroup = preferred === "openrouter" ? openrouter : codex;
  const fallbackGroup = codex ?? openrouter!;
  const initialGroup = preferredGroup ?? fallbackGroup;
  const initial = `${preferredGroup ? preferred : codex ? "codex" : "openrouter"}:${initialGroup.group.initial ?? initialGroup.group.fallback}`;
  const fallback = `${codex ? "codex" : "openrouter"}:${fallbackGroup.group.fallback}`;

  const selected = (value: PickValue): LaunchPresetChoice => {
    const picked = value ?? initial;
    const separator = picked.indexOf(":");
    const prefix = separator < 0 ? "" : picked.slice(0, separator);
    const inner = separator < 0 ? picked : picked.slice(separator + 1);
    if (prefix === "openrouter" && openrouter) {
      const choice: OpenRouterModelChoice = openrouter.selected(inner);
      return { provider: "openrouter", openrouter: choice.settings };
    }
    if (codex) return { provider: "codex", codex: codex.selected(inner) };
    const choice: OpenRouterModelChoice = openrouter!.selected(inner);
    return { provider: "openrouter", openrouter: choice.settings };
  };

  return {
    group: {
      key: "r",
      options,
      perRow: 2,
      initial,
      fallback,
      summary: (value) => {
        const choice = selected(value);
        return choice.provider === "codex"
          ? `⚙️ Codex · ${codex!.group.summary(value?.replace(/^codex:/, "") ?? null)}`
          : `🌐 OpenRouter · ${openrouter!.group.summary(value?.replace(/^openrouter:/, "") ?? null)}`;
      },
    },
    selected,
  };
}
