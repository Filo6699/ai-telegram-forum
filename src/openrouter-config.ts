import type { PickGroup, PickValue } from "./picker.ts";
import { normalizeOpenRouterModel } from "./openrouter-model.ts";

export type OpenRouterReasoning = unknown;

export interface OpenRouterProviderPreferences {
  [key: string]: unknown;
}

export interface OpenRouterPresetConfig {
  name: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  reasoning?: OpenRouterReasoning;
  provider?: OpenRouterProviderPreferences;
  fallbacks?: string[];
}

/** Settings persisted for a topic. `model: null` means OPENROUTER_MODEL. */
export interface OpenRouterSettings {
  model: string | null;
  preset?: string | null;
  temperature?: number;
  maxTokens?: number;
  reasoning?: OpenRouterReasoning;
  provider?: OpenRouterProviderPreferences;
  fallbacks?: string[];
}

const MODEL_ID = /^[a-z0-9][a-z0-9._:+~/-]*$/i;

function model(name: string, where: string): string {
  const value = normalizeOpenRouterModel(name);
  if (!value || !MODEL_ID.test(value) || !value.includes("/")) {
    throw new Error(`${where} is not a valid OpenRouter model id or link`);
  }
  return value;
}

function optionalNumber(
  item: Record<string, unknown>,
  key: string,
  where: string,
  integer = false,
): number | undefined {
  const value = item[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || (integer && !Number.isInteger(value))) {
    throw new Error(`${where}.${key} must be a finite${integer ? " integer" : " number"}`);
  }
  if (key === "max_tokens" && value <= 0) throw new Error(`${where}.max_tokens must be positive`);
  return value;
}

function optionalObject(
  item: Record<string, unknown>,
  key: string,
  where: string,
): Record<string, unknown> | undefined {
  const value = item[key];
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${where}.${key} must be a JSON object`);
  }
  return { ...(value as Record<string, unknown>) };
}

function optionalFallbacks(
  item: Record<string, unknown>,
  where: string,
): string[] | undefined {
  const raw = item.fallbacks ?? item.models;
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.some((value) => typeof value !== "string")) {
    throw new Error(`${where}.fallbacks must be an array of model ids or links`);
  }
  if (raw.length > 3) throw new Error(`${where}.fallbacks supports at most 3 models`);
  return raw.map((value, index) => model(value, `${where}.fallbacks[${index}]`));
}

function parsePreset(name: string, value: unknown): OpenRouterPresetConfig {
  const where = `OPENROUTER_PRESETS[${name}]`;
  if (!name.trim() || name.length > 40) {
    throw new Error("OPENROUTER_PRESETS labels must contain 1–40 characters");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${where} must be an object`);
  }
  const item = value as Record<string, unknown>;
  const rawModel = typeof item.model === "string" ? item.model : "";
  return {
    name,
    model: model(rawModel, `${where}.model`),
    temperature: optionalNumber(item, "temperature", where),
    maxTokens: optionalNumber(item, "max_tokens", where, true),
    reasoning: item.reasoning === null ? undefined : item.reasoning,
    provider:
      optionalObject(item, "provider", where) ??
      optionalObject(item, "provider_preferences", where),
    fallbacks: optionalFallbacks(item, where),
  };
}

/** Parse `{ "Free": { "model": "openrouter/free" } }`. */
export function parseOpenRouterPresets(raw: string | undefined): OpenRouterPresetConfig[] {
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`OPENROUTER_PRESETS is not valid JSON: ${raw}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("OPENROUTER_PRESETS must be a JSON object keyed by button label");
  }
  const presets = Object.entries(parsed).map(([name, value]) => parsePreset(name, value));
  if (!presets.length) throw new Error("OPENROUTER_PRESETS must contain at least one preset");
  return presets;
}

export function presetSettings(preset: OpenRouterPresetConfig): OpenRouterSettings {
  return {
    model: preset.model,
    preset: preset.name,
    ...(preset.temperature === undefined ? {} : { temperature: preset.temperature }),
    ...(preset.maxTokens === undefined ? {} : { maxTokens: preset.maxTokens }),
    ...(preset.reasoning === undefined ? {} : { reasoning: preset.reasoning }),
    ...(preset.provider === undefined ? {} : { provider: { ...preset.provider } }),
    ...(preset.fallbacks === undefined ? {} : { fallbacks: [...preset.fallbacks] }),
  };
}

export interface OpenRouterModelChoice {
  kind: "preset" | "model";
  settings: OpenRouterSettings;
}

function labelForModel(id: string, defaultModel: string): string {
  return id === defaultModel ? `${id} (default)` : id;
}

/** One short callback per option; the full model id stays server-side. */
export function openRouterModelPicker(
  initial: OpenRouterSettings | null | undefined,
  defaultModel: string,
  presets: OpenRouterPresetConfig[],
): { group: PickGroup; selected(value: PickValue): OpenRouterModelChoice } {
  const options = [
    ...presets.map((preset, index) => ({ value: `preset:${index}`, label: `🎛️ ${preset.name}` })),
    { value: `model:${defaultModel}`, label: labelForModel(defaultModel, defaultModel) },
  ];
  const currentModel = initial?.model ?? defaultModel;
  if (!options.some((option) => option.value === `model:${currentModel}`)) {
    options.push({ value: `model:${currentModel}`, label: currentModel });
  }
  const presetIndex = initial?.preset
    ? presets.findIndex((preset) => preset.name === initial.preset)
    : -1;
  const initialValue = presetIndex >= 0 ? `preset:${presetIndex}` : `model:${currentModel}`;
  const fallback = `model:${defaultModel}`;

  const selected = (value: PickValue): OpenRouterModelChoice => {
    const picked = value ?? initialValue;
    const presetMatch = /^preset:(\d+)$/.exec(picked);
    if (presetMatch) {
      const preset = presets[Number(presetMatch[1])];
      if (preset) return { kind: "preset", settings: presetSettings(preset) };
    }
    const modelId = picked.replace(/^model:/, "");
    return {
      kind: "model",
      settings: modelId === defaultModel ? { model: null } : { model: modelId },
    };
  };

  return {
    group: {
      key: "o",
      options,
      perRow: 2,
      initial: initialValue,
      fallback,
      summary: (value) => {
        const choice = selected(value);
        return choice.kind === "preset"
          ? `🎛️ preset: ${choice.settings.preset ?? "custom"}`
          : `🤖 model: ${choice.settings.model ?? `${defaultModel} (default)`}`;
      },
    },
    selected,
  };
}
