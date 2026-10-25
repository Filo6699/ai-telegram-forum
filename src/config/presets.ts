// Type-only imports: this module is loaded while `cfg` is being built.
import type { Effort, EffortLevel } from "./effort.ts";
import type { Model } from "./model.ts";
import type { OpenRouterSettings } from "./openrouter-settings.ts";
import { parseOpenRouterPreset } from "./openrouter-settings.ts";
import type { Provider } from "./provider.ts";
import type { ServiceTier } from "./service-tier.ts";

/** Everything a topic runs on besides its provider and session id. */
export interface ModelSettings {
  model: Model;
  effort: Effort;
  serviceTier: ServiceTier;
  openrouter: OpenRouterSettings | null;
}

/** One `PRESETS` entry: a button label, the agent it starts, and its settings. */
export interface Preset {
  name: string;
  provider: Provider;
  settings: ModelSettings;
}

export const NO_SETTINGS: ModelSettings = {
  model: null,
  effort: null,
  serviceTier: null,
  openrouter: null,
};

const CLAUDE_EFFORTS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
const CODEX_EFFORTS: EffortLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
const PROVIDERS: Provider[] = ["claude", "codex", "openrouter"];

function parseEffortField(item: Record<string, unknown>, where: string, levels: EffortLevel[]): EffortLevel {
  const raw = typeof item.effort === "string" ? item.effort.trim().toLowerCase() : "";
  // "light" is a convenient name for what both CLIs call "low".
  const effort = (raw === "light" ? "low" : raw) as EffortLevel;
  if (!levels.includes(effort)) {
    throw new Error(`${where}.effort must be ${levels.join(", ")}`);
  }
  return effort;
}

function parseClaudePreset(item: Record<string, unknown>, where: string): ModelSettings {
  const model = typeof item.model === "string" ? item.model.trim() : "";
  if (!/^claude-[a-z0-9.[\]_-]+$/i.test(model)) {
    throw new Error(`${where}.model is not a valid Claude model id`);
  }
  return { ...NO_SETTINGS, model, effort: parseEffortField(item, where, CLAUDE_EFFORTS) };
}

function parseCodexPreset(item: Record<string, unknown>, where: string): ModelSettings {
  const model = typeof item.model === "string" ? item.model.trim() : "";
  if (!/^[a-z0-9][a-z0-9.[\]_-]+$/i.test(model)) {
    throw new Error(`${where}.model is not a valid model id`);
  }
  if (item.fast !== undefined && typeof item.fast !== "boolean") {
    throw new Error(`${where}.fast must be true or false`);
  }
  const tier = item.serviceTier ?? item.service_tier;
  if (tier !== undefined && tier !== "default" && tier !== "fast") {
    throw new Error(`${where}.serviceTier must be default or fast`);
  }
  return {
    ...NO_SETTINGS,
    model,
    effort: parseEffortField(item, where, CODEX_EFFORTS),
    serviceTier: item.fast === true ? "fast" : (tier ?? "default"),
  };
}

function parseOpenRouter(name: string, item: Record<string, unknown>, where: string): ModelSettings {
  const openrouter = parseOpenRouterPreset(name, item, where);
  return { ...NO_SETTINGS, model: openrouter.model, openrouter };
}

function parsePreset(name: string, value: unknown): Preset {
  const where = `PRESETS[${name}]`;
  if (!name.trim() || name.length > 40) throw new Error("PRESETS labels must contain 1–40 characters");
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${where} must be an object`);
  }
  const item = value as Record<string, unknown>;
  const provider = item.provider as Provider;
  if (!PROVIDERS.includes(provider)) {
    throw new Error(`${where}.provider must be ${PROVIDERS.join(", ")}`);
  }
  const settings =
    provider === "claude"
      ? parseClaudePreset(item, where)
      : provider === "codex"
        ? parseCodexPreset(item, where)
        : parseOpenRouter(name, item, where);
  return { name, provider, settings };
}

/** Parse `{ "OH": { "provider": "claude", "model": "claude-opus-5-5", "effort": "high" } }`. */
export function parsePresets(raw: Record<string, unknown> | undefined): Preset[] {
  if (raw === undefined) return [];
  const presets = Object.entries(raw).map(([name, value]) => parsePreset(name, value));
  const seen = new Set<string>();
  for (const { name } of presets) {
    const key = name.toLowerCase();
    if (seen.has(key)) throw new Error(`PRESETS has two presets named ${name} (labels ignore case)`);
    seen.add(key);
  }
  return presets;
}

/**
 * The preset a launch starts on. It has to belong to `provider`, the default
 * agent: one default per bot, rather than one per provider that could disagree.
 */
export function parseDefaultPreset(
  raw: string | undefined,
  presets: Preset[],
  provider: Provider,
): string | null {
  const wanted = raw?.trim();
  if (!wanted) return presets.find((preset) => preset.provider === provider)?.name ?? null;
  const match = findPresetByName(presets, wanted);
  if (!match) throw new Error(`DEFAULT_PRESET does not name a configured preset: ${wanted}`);
  if (match.provider !== provider) {
    throw new Error(`DEFAULT_PRESET ${match.name} is a ${match.provider} preset, but PROVIDER is ${provider}`);
  }
  return match.name;
}

export const findPresetByName = (presets: Preset[], name: string): Preset | undefined =>
  presets.find((preset) => preset.name.toLowerCase() === name.toLowerCase());

/**
 * The preset an exact set of settings came from. OpenRouter settings carry the
 * preset name themselves; the others match on model, effort and tier.
 */
export function matchPreset(
  presets: Preset[],
  provider: Provider,
  settings: ModelSettings,
): Preset | undefined {
  return presets.find((preset) => {
    if (preset.provider !== provider) return false;
    if (provider === "openrouter") return settings.openrouter?.preset === preset.name;
    return (
      preset.settings.model === settings.model &&
      preset.settings.effort === settings.effort &&
      preset.settings.serviceTier === settings.serviceTier
    );
  });
}

/** Copy settings so a topic never shares nested objects with the config. */
export function cloneSettings(settings: ModelSettings): ModelSettings {
  const openrouter = settings.openrouter;
  return {
    ...settings,
    openrouter: openrouter && {
      ...openrouter,
      ...(openrouter.provider ? { provider: { ...openrouter.provider } } : {}),
      ...(openrouter.fallbacks ? { fallbacks: [...openrouter.fallbacks] } : {}),
    },
  };
}

const LEGACY_KEYS = ["CODEX_PRESETS", "CODEX_DEFAULT_PRESET", "OPENROUTER_PRESETS"] as const;

/**
 * Move the old per-provider preset keys into `PRESETS`. Only the migration
 * tool calls this; config.json itself must use the one block.
 */
export function upgradeLegacyPresets(raw: Record<string, unknown>): Record<string, unknown> {
  if (!LEGACY_KEYS.some((key) => key in raw)) return raw;
  const { CODEX_PRESETS, CODEX_DEFAULT_PRESET, OPENROUTER_PRESETS, ...rest } = raw;
  const tagged = (group: unknown, provider: Provider) =>
    Object.entries((group ?? {}) as Record<string, unknown>).map(([name, value]) => {
      const item: Record<string, unknown> = { ...(value as Record<string, unknown>), provider };
      if (provider === "openrouter" && "provider" in (value as object)) {
        item.routing = (value as Record<string, unknown>).provider;
      }
      return [name, item] as const;
    });
  const upgraded: Record<string, unknown> = {
    ...rest,
    PRESETS: {
      ...(rest.PRESETS as Record<string, unknown> | undefined),
      ...Object.fromEntries([...tagged(CODEX_PRESETS, "codex"), ...tagged(OPENROUTER_PRESETS, "openrouter")]),
    },
  };
  // The old default only ever applied to Codex launches.
  if (CODEX_DEFAULT_PRESET !== undefined && rest.PROVIDER === "codex" && rest.DEFAULT_PRESET === undefined) {
    upgraded.DEFAULT_PRESET = CODEX_DEFAULT_PRESET;
  }
  return upgraded;
}

/** Point at the new block instead of failing on an "unrecognized key". */
export function rejectLegacyPresets(raw: unknown): void {
  if (!raw || typeof raw !== "object") return;
  const found = LEGACY_KEYS.filter((key) => key in raw);
  if (found.length) {
    throw new Error(
      `Invalid config.json: ${found.join(", ")} moved into PRESETS — give each preset ` +
        `a "provider" ("claude", "codex" or "openrouter") and use DEFAULT_PRESET for the default`,
    );
  }
}
