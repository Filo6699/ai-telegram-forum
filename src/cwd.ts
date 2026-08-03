import { cfg } from "./config.ts";

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

  const path = trimmed.match(/^(\/\S+)\s+([\s\S]+)$/);
  if (path) {
    const [, dir, rest] = path as unknown as [string, string, string];
    return { cwd: dir, prompt: rest };
  }

  return { cwd: cfg.defaultCwd, prompt: trimmed };
}

/** Short, human-friendly topic title derived from the first prompt. */
export function titleFrom(prompt: string): string {
  const firstLine = prompt.split("\n")[0]?.trim() ?? "session";
  const clipped = firstLine.slice(0, 60);
  return clipped.length ? clipped : "session";
}
