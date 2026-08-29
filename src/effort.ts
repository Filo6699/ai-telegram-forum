import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PickGroup, PickValue } from "./picker.ts";
import type { Provider } from "./provider.ts";

/** `null` means "whatever the provider defaults to" — no copied default is stored. */
export type EffortLevel =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra"
  | "persistent";
export type Effort = EffortLevel | null;

const CLAUDE_LEVELS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
const CODEX_LEVELS: EffortLevel[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];
const levelsFor = (provider: Provider): EffortLevel[] =>
  provider === "codex" ? CODEX_LEVELS : CLAUDE_LEVELS;

/** What the SDK documents as the effort a model runs on when nothing sets one. */
const CLAUDE_BUILT_IN_DEFAULT: EffortLevel = "high";
const CODEX_BUILT_IN_DEFAULT: EffortLevel = "low";

/**
 * The level Claude itself would run on in `cwd` — the one shown pre-selected,
 * since "default" is a level like any other, not a menu entry of its own.
 * Read from the settings files the CLI reads, in its precedence order, so it
 * follows a `/effort` the user set in a terminal instead of us keeping a copy.
 */
export function defaultEffort(cwd: string, provider: Provider = "claude"): EffortLevel {
  if (provider === "codex") return defaultCodexEffort();
  const files = [
    "/etc/claude-code/managed-settings.json",
    join(cwd, ".claude", "settings.local.json"),
    join(cwd, ".claude", "settings.json"),
    join(homedir(), ".claude", "settings.json"),
  ];
  for (const file of files) {
    const level = readEffortLevel(file);
    if (level) return level;
  }
  return CLAUDE_BUILT_IN_DEFAULT;
}

function defaultCodexEffort(): EffortLevel {
  const fromEnv = process.env.CODEX_EFFORT;
  if (fromEnv) {
    const parsed = parseEffort(fromEnv, "codex");
    if (parsed) return parsed;
  }
  try {
    const toml = readFileSync(join(homedir(), ".codex", "config.toml"), "utf8");
    const value = /^\s*model_reasoning_effort\s*=\s*["']([^"']+)["']/m.exec(toml)?.[1];
    const parsed = value ? parseEffort(value, "codex") : undefined;
    if (parsed) return parsed;
  } catch {
    // Missing config is the normal first-run state.
  }
  return CODEX_BUILT_IN_DEFAULT;
}

function readEffortLevel(file: string): EffortLevel | null {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { effortLevel?: string };
    return (raw.effortLevel ? parseEffort(raw.effortLevel, "claude") : null) ?? null;
  } catch {
    return null; // missing, unreadable or not JSON — the next source answers
  }
}

/** `fallback` names the level an unset effort resolves to, when we know it. */
export const effortLabel = (e: Effort, fallback?: EffortLevel): string =>
  e ?? (fallback ? `${fallback} (default)` : "default");

/** Parse a `/effort <level>` argument. `undefined` = not a level we know. */
export function parseEffort(raw: string, provider: Provider = "claude"): Effort | undefined {
  const v = raw.trim().toLowerCase();
  if (v === "default" || v === "reset" || v === "-") return null;
  return (levelsFor(provider) as string[]).includes(v) ? (v as EffortLevel) : undefined;
}

/** A picked button back into an effort — the keyboard only carries real levels. */
export const asEffort = (v: PickValue, provider: Provider = "claude"): Effort =>
  v ? (parseEffort(v, provider) ?? null) : null;

/** What `/effort` says when it doesn't recognise its argument. */
export const effortUsage = (provider: Provider): string =>
  `⚠️ unknown effort. Use one of: ${levelsFor(provider).join(", ")}, default.`;

/**
 * The five levels, tick on the one in force. Nothing picked yet means the
 * session runs on the level Claude resolves for `cwd`, so that is what the tick
 * sits on — the default is a level, not an extra button.
 */
export function effortGroup(initial: Effort, cwd: string, provider: Provider = "claude"): PickGroup {
  const fallback = defaultEffort(cwd, provider);
  return {
    key: "e",
    options: levelsFor(provider).map((l) => ({ value: l, label: l })),
    perRow: 3,
    initial,
    fallback,
    summary: (v) => `⚙️ effort: ${effortLabel(asEffort(v, provider), fallback)}`,
  };
}
