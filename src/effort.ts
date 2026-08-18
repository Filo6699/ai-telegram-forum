import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import type { PickGroup, PickValue } from "./picker.ts";

/** `null` means "whatever Claude itself defaults to" — we never store a default of our own. */
export type Effort = EffortLevel | null;

const LEVELS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

/** What the SDK documents as the effort a model runs on when nothing sets one. */
const BUILT_IN_DEFAULT: EffortLevel = "high";

/**
 * The level Claude itself would run on in `cwd` — the one shown pre-selected,
 * since "default" is a level like any other, not a menu entry of its own.
 * Read from the settings files the CLI reads, in its precedence order, so it
 * follows a `/effort` the user set in a terminal instead of us keeping a copy.
 */
export function defaultEffort(cwd: string): EffortLevel {
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
  return BUILT_IN_DEFAULT;
}

function readEffortLevel(file: string): EffortLevel | null {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { effortLevel?: string };
    return (raw.effortLevel ? parseEffort(raw.effortLevel) : null) ?? null;
  } catch {
    return null; // missing, unreadable or not JSON — the next source answers
  }
}

/** `fallback` names the level an unset effort resolves to, when we know it. */
export const effortLabel = (e: Effort, fallback?: EffortLevel): string =>
  e ?? (fallback ? `${fallback} (default)` : "default");

/** Parse a `/effort <level>` argument. `undefined` = not a level we know. */
export function parseEffort(raw: string): Effort | undefined {
  const v = raw.trim().toLowerCase();
  if (v === "default" || v === "reset" || v === "-") return null;
  return (LEVELS as string[]).includes(v) ? (v as EffortLevel) : undefined;
}

/** A picked button back into an effort — the keyboard only carries real levels. */
export const asEffort = (v: PickValue): Effort => (v ? (parseEffort(v) ?? null) : null);

/** What `/effort` says when it doesn't recognise its argument. */
export const effortUsage = `⚠️ unknown effort. Use one of: ${LEVELS.join(", ")}, default.`;

/**
 * The five levels, tick on the one in force. Nothing picked yet means the
 * session runs on the level Claude resolves for `cwd`, so that is what the tick
 * sits on — the default is a level, not an extra button.
 */
export function effortGroup(initial: Effort, cwd: string): PickGroup {
  const fallback = defaultEffort(cwd);
  return {
    key: "e",
    options: LEVELS.map((l) => ({ value: l, label: l })),
    perRow: 3,
    initial,
    fallback,
    summary: (v) => `⚙️ effort: ${effortLabel(asEffort(v), fallback)}`,
  };
}
