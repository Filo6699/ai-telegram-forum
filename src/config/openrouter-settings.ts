import { normalizeOpenRouterModel } from "./openrouter-model.ts";

export type OpenRouterReasoning = unknown;

export interface OpenRouterProviderPreferences {
  [key: string]: unknown;
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

/**
 * The OpenRouter half of one `PRESETS` entry. Routing preferences are spelled
 * `routing` there, because `provider` already names the agent.
 */
export function parseOpenRouterPreset(
  name: string,
  item: Record<string, unknown>,
  where: string,
): OpenRouterSettings {
  const rawModel = typeof item.model === "string" ? item.model : "";
  const temperature = optionalNumber(item, "temperature", where);
  const maxTokens = optionalNumber(item, "max_tokens", where, true);
  const reasoning = item.reasoning ?? undefined;
  const routing =
    optionalObject(item, "routing", where) ?? optionalObject(item, "provider_preferences", where);
  const fallbacks = optionalFallbacks(item, where);
  return {
    model: model(rawModel, `${where}.model`),
    preset: name,
    ...(temperature === undefined ? {} : { temperature }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(routing === undefined ? {} : { provider: routing }),
    ...(fallbacks === undefined ? {} : { fallbacks }),
  };
}
