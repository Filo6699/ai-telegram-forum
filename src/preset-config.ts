export type ServiceTier = "default" | "fast" | null;

export interface CodexPresetConfig {
  name: string;
  model: string;
  effort: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /** `fast` is Codex's higher-throughput service tier; `default` is regular mode. */
  serviceTier: Exclude<ServiceTier, null>;
}

export const serviceTierLabel = (tier: ServiceTier): string =>
  tier === "fast" ? "fast" : tier === "default" ? "standard" : "default";

const DEFAULT_CODEX_PRESETS: CodexPresetConfig[] = [
  { name: "Light", model: "gpt-5.6-sol", effort: "low", serviceTier: "default" },
  { name: "Flash", model: "gpt-5.6-sol", effort: "low", serviceTier: "fast" },
  { name: "Normal", model: "gpt-5.6-sol", effort: "medium", serviceTier: "default" },
  { name: "Decent", model: "gpt-5.6-sol", effort: "high", serviceTier: "default" },
];

const EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);

/** Parse `{ "Flash": { "model": "gpt-5.6-sol", "effort": "low", "fast": true } }`. */
export function parseCodexPresets(raw: string | undefined): CodexPresetConfig[] {
  if (!raw) return DEFAULT_CODEX_PRESETS.map((preset) => ({ ...preset }));

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`CODEX_PRESETS is not valid JSON: ${raw}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("CODEX_PRESETS must be a JSON object keyed by button label");
  }

  const presets = Object.entries(parsed).map(([name, value]) => {
    if (!name.trim() || name.length > 40) {
      throw new Error("CODEX_PRESETS labels must contain 1–40 characters");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`CODEX_PRESETS[${name}] must be an object`);
    }
    const item = value as Record<string, unknown>;
    const model = typeof item.model === "string" ? item.model.trim() : "";
    if (!/^[a-z0-9][a-z0-9.[\]_-]+$/i.test(model)) {
      throw new Error(`CODEX_PRESETS[${name}].model is not a valid model id`);
    }

    const namedEffort = typeof item.effort === "string" ? item.effort.trim().toLowerCase() : "";
    // "light" is a convenient name for what Codex itself calls "low".
    const effort = namedEffort === "light" ? "low" : namedEffort;
    if (!EFFORTS.has(effort)) {
      throw new Error(
        `CODEX_PRESETS[${name}].effort must be minimal, low, medium, high, xhigh, or max`,
      );
    }

    if (item.fast !== undefined && typeof item.fast !== "boolean") {
      throw new Error(`CODEX_PRESETS[${name}].fast must be true or false`);
    }
    const explicitTier = item.serviceTier ?? item.service_tier;
    if (explicitTier !== undefined && explicitTier !== "default" && explicitTier !== "fast") {
      throw new Error(`CODEX_PRESETS[${name}].serviceTier must be default or fast`);
    }
    const serviceTier = item.fast === true ? "fast" : (explicitTier ?? "default");

    return {
      name,
      model,
      effort: effort as CodexPresetConfig["effort"],
      serviceTier: serviceTier as CodexPresetConfig["serviceTier"],
    };
  });

  if (!presets.length) throw new Error("CODEX_PRESETS must contain at least one preset");
  return presets;
}

export function parseDefaultCodexPreset(
  raw: string | undefined,
  presets: CodexPresetConfig[],
): string {
  const wanted =
    raw?.trim() ||
    (presets.some((preset) => preset.name === "Decent") ? "Decent" : presets[0]!.name);
  const match = presets.find((preset) => preset.name.toLowerCase() === wanted.toLowerCase());
  if (!match) {
    throw new Error(`CODEX_DEFAULT_PRESET does not name a configured preset: ${wanted}`);
  }
  return match.name;
}
