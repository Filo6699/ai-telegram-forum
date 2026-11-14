import { resolve } from "node:path";
import { z } from "zod";
import { cfg } from "../config/env.ts";
import { parseEffort } from "../config/effort.ts";
import { parseModel } from "../config/model.ts";
import { cloneSettings, findPresetByName, type ModelSettings } from "../config/presets.ts";
import { parseProvider, type Provider } from "../config/provider.ts";
import { launchPicker, type LaunchChoice } from "../telegram/presets.ts";
import { isDirectory, placeholderTitle } from "./cwd.ts";

const text = z.string().trim().min(1);

/**
 * A launch that another program on this machine asks for, instead of a user
 * typing into the launcher. Nobody is there to answer a picker, so the request
 * names everything a picker would: folder, preset or model settings, title.
 */
export const launchRequestSchema = z.strictObject({
  prompt: text,
  /** Absolute path or a `PROJECTS` alias with its `@`; `DEFAULT_CWD` if omitted. */
  cwd: text.optional(),
  /** A fixed title. Without one the topic is named like a launcher one. */
  title: text.max(128).optional(),
  preset: text.optional(),
  provider: text.optional(),
  model: text.optional(),
  effort: text.optional(),
  serviceTier: z.enum(["default", "fast"]).optional(),
});

export type LaunchRequest = z.infer<typeof launchRequestSchema>;

export interface ResolvedLaunch {
  prompt: string;
  cwd: string;
  title: string;
  choice: LaunchChoice;
}

function resolveFolder(raw: string | undefined): string {
  if (raw === undefined) return cfg.defaultCwd;
  let cwd = raw;
  if (raw.startsWith("@")) {
    const alias = cfg.projects[raw.slice(1)];
    if (!alias) throw new Error(`unknown project alias ${raw}`);
    cwd = alias;
  } else if (!raw.startsWith("/")) {
    throw new Error(`cwd must be an absolute path or a @project alias, got ${raw}`);
  }
  if (!isDirectory(cwd)) throw new Error(`folder ${cwd} doesn't exist`);
  return resolve(cwd);
}

/** A model id alone is enough to tell Claude apart; others need `provider`. */
function providerOf(request: LaunchRequest): Provider {
  if (request.provider !== undefined) {
    const provider = parseProvider(request.provider);
    if (!provider) throw new Error(`unknown provider ${request.provider}`);
    return provider;
  }
  return request.model?.toLowerCase().startsWith("claude-") ? "claude" : cfg.provider;
}

function resolveChoice(request: LaunchRequest): LaunchChoice {
  const { preset: presetName, model: rawModel, effort: rawEffort, serviceTier } = request;
  if (presetName !== undefined) {
    if (request.provider !== undefined || rawModel !== undefined || rawEffort !== undefined || serviceTier !== undefined) {
      throw new Error("give either preset or provider/model/effort, not both");
    }
    const preset = findPresetByName(cfg.presets, presetName);
    if (!preset) throw new Error(`no preset named ${presetName}`);
    return { provider: preset.provider, settings: cloneSettings(preset.settings), preset: preset.name };
  }

  const provider = providerOf(request);
  if (provider === "openrouter" && !cfg.openrouterEnabled) {
    throw new Error("OpenRouter needs OPENROUTER_API_KEY in .env");
  }
  const overrides: Partial<ModelSettings> = {};
  if (rawModel !== undefined) {
    const model = parseModel(rawModel, provider);
    if (model === undefined) throw new Error(`${rawModel} is not a ${provider} model`);
    overrides.model = model;
    if (provider === "openrouter") overrides.openrouter = model ? { model, preset: null } : null;
  }
  if (rawEffort !== undefined) {
    if (provider === "openrouter") throw new Error("OpenRouter has no effort setting");
    const effort = parseEffort(rawEffort, provider);
    if (effort === undefined) throw new Error(`${rawEffort} is not a ${provider} effort level`);
    overrides.effort = effort;
  }
  if (serviceTier !== undefined) {
    if (provider !== "codex") throw new Error("serviceTier applies to Codex only");
    overrides.serviceTier = serviceTier;
  }
  // The same resolution as launcher `/model` + an untouched picker: settings
  // that match a preset start as that preset, no settings start the default.
  const picker = launchPicker(provider, overrides);
  if (picker) return picker.selected(null);
  return {
    provider,
    settings: {
      model: overrides.model ?? null,
      effort: overrides.effort ?? null,
      serviceTier: provider === "codex" ? (overrides.serviceTier ?? "default") : null,
      openrouter: overrides.openrouter ?? null,
    },
    preset: null,
  };
}

/** Validate a queued request against this bot's configuration. Throws with the reason. */
export function resolveLaunchRequest(raw: unknown): ResolvedLaunch {
  const parsed = launchRequestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((issue) =>
      `${issue.path.join(".") || "request"}: ${issue.message}`).join("; "));
  }
  const request = parsed.data;
  return {
    prompt: request.prompt,
    cwd: resolveFolder(request.cwd),
    title: request.title ?? placeholderTitle(request.prompt),
    choice: resolveChoice(request),
  };
}
