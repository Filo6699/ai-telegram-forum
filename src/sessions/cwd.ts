import { statSync } from "node:fs";
import { resolve } from "node:path";
import { cfg } from "../config/env.ts";

export interface Resolved {
  cwd: string;
  prompt: string;
}

/**
 * Parse an optional working-directory prefix from a launcher message.
 *
 *   "fix flaky tests"              -> { cwd: defaultCwd, prompt: "fix flaky tests" }
 *   "@myrepo fix flaky tests"      -> { cwd: projects.myrepo, prompt: "fix flaky tests" }
 *   "/srv/app fix flaky tests"     -> { cwd: "/srv/app",      prompt: "fix flaky tests" }
 *
 * An unknown "@alias" falls back to defaultCwd (and the alias stays in the prompt,
 * so nothing is silently swallowed).
 */
export function resolveCwd(text: string): Resolved {
  const trimmed = text.trim();

  const alias = trimmed.match(/^@([\w-]+)\s+([\s\S]+)$/);
  if (alias) {
    const [, name, rest] = alias as unknown as [string, string, string];
    const cwd = cfg.projects[name];
    if (cwd) return { cwd, prompt: rest };
    return { cwd: cfg.defaultCwd, prompt: trimmed }; // unknown alias -> keep verbatim
  }

  const path = trimmed.match(/^(\/\S*)\s+([\s\S]+)$/);
  if (path) {
    const [, dir, rest] = path as unknown as [string, string, string];
    return { cwd: dir, prompt: rest };
  }

  return { cwd: cfg.defaultCwd, prompt: trimmed };
}

/** Is there a directory a session could start in at this path? */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
  } catch {
    return false;
  }
}

/**
 * The folders a launch can fall back to when its own cwd is missing: the
 * default first, then every project alias, each path once and only if it exists.
 */
export function existingFolders(): { name: string; cwd: string }[] {
  const seen = new Set<string>();
  const folders: { name: string; cwd: string }[] = [];
  for (const [name, cwd] of [["default", cfg.defaultCwd], ...Object.entries(cfg.projects)] as [string, string][]) {
    const key = resolve(cwd);
    if (seen.has(key) || !isDirectory(cwd)) continue;
    seen.add(key);
    const alias = Object.entries(cfg.projects).find(([, path]) => resolve(path) === key)?.[0];
    folders.push({ name: alias ?? name, cwd });
  }
  return folders;
}

/**
 * Marks a title as still provisional: the topic is named from the first prompt
 * until Claude generates its own session title, which then replaces it.
 */
export const PENDING_TITLE_MARK = "⏳ ";

/** Is this title still the placeholder we set at launch? */
export const isPendingTitle = (title: string): boolean =>
  title.startsWith(PENDING_TITLE_MARK);

/** Short, human-friendly topic title derived from the first prompt. */
export function titleFrom(prompt: string): string {
  const firstLine = prompt.split("\n")[0]?.trim() ?? "session";
  const clipped = firstLine.slice(0, 60);
  return clipped.length ? clipped : "session";
}

/** The provisional title a topic carries until Claude names the session. */
export const placeholderTitle = (prompt: string): string =>
  (PENDING_TITLE_MARK + titleFrom(prompt)).slice(0, 128);
