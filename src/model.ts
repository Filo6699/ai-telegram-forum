import { cfg } from "./config.ts";
import type { PickGroup, PickValue } from "./picker.ts";

/**
 * `null` means "no choice of ours" — the session runs on `MODEL` from the env,
 * the same way an unset effort runs on whatever Claude resolves for the cwd.
 */
export type Model = string | null;

interface Known {
  id: string;
  label: string;
  /** What `/model <alias>` accepts on top of the full id. */
  alias: string;
}

/**
 * The models offered as buttons. Ids, not aliases: the tick has to land on the
 * row that matches `MODEL`, which is written out in full in `.env`. An id we
 * don't list is still reachable — `parseModel` takes any `claude-…` string.
 */
const MODELS: Known[] = [
  { id: "claude-opus-5", label: "Opus 5", alias: "opus" },
  { id: "claude-sonnet-5", label: "Sonnet 5", alias: "sonnet" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", alias: "haiku" },
  { id: "claude-fable-5", label: "Fable 5", alias: "fable" },
];

/** The model a topic runs on when it has picked none: what `MODEL=` names. */
export const defaultModel = (): string => cfg.model;

/** A model id as a human reads it — its display name, or the id itself. */
const displayName = (id: string): string => MODELS.find((m) => m.id === id)?.label ?? id;

/** `fallback` names the model an unset choice resolves to, when we know it. */
export const modelLabel = (m: Model, fallback?: string): string =>
  m ? displayName(m) : fallback ? `${displayName(fallback)} (default)` : "default";

/** Parse a `/model <name>` argument. `undefined` = not a model we can use. */
export function parseModel(raw: string): Model | undefined {
  const v = raw.trim();
  const lower = v.toLowerCase();
  if (lower === "default" || lower === "reset" || lower === "-") return null;
  const known = MODELS.find((m) => m.alias === lower || m.id.toLowerCase() === lower);
  if (known) return known.id;
  // An id we don't list is still a model the CLI may well accept — pass it on
  // rather than making the button list the limit of what can be run.
  return /^claude-[a-z0-9.[\]_-]+$/i.test(v) ? v : undefined;
}

/** A picked button back into a model — the keyboard only carries real ids. */
export const asModel = (v: PickValue): Model => v ?? null;

export const modelUsage =
  `⚠️ unknown model. Use one of: ${MODELS.map((m) => m.alias).join(", ")}, default` +
  ` — or a full \`claude-…\` id.`;

/**
 * The known models, tick on the one in force. `MODEL` from the env is the
 * default and gets its own button when it isn't one of the listed ids, so the
 * tick always has somewhere to sit.
 */
export function modelGroup(initial: Model): PickGroup {
  const fallback = defaultModel();
  const known = MODELS.map((m) => ({ value: m.id, label: m.label }));
  const options = known.some((o) => o.value === fallback)
    ? known
    : [{ value: fallback, label: displayName(fallback) }, ...known];
  return {
    key: "m",
    options,
    perRow: 2,
    initial,
    fallback,
    summary: (v) => `🤖 model: ${modelLabel(asModel(v), fallback)}`,
  };
}
