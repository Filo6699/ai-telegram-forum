import { cfg } from "./config.ts";
import type { PickGroup, PickValue } from "./picker.ts";
import type { Provider } from "./provider.ts";

/**
 * `null` means "no choice of ours" — the session runs on its provider's model
 * from the env, like an unset effort uses that provider's own resolution.
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
 * row that matches the configured default. Full ids remain reachable even when
 * they are not in these compact lists.
 */
const CLAUDE_MODELS: Known[] = [
  { id: "claude-opus-5", label: "Opus 5", alias: "opus" },
  { id: "claude-sonnet-5", label: "Sonnet 5", alias: "sonnet" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", alias: "haiku" },
  { id: "claude-fable-5", label: "Fable 5", alias: "fable" },
];

const CODEX_MODELS: Known[] = [
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", alias: "sol" },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", alias: "terra" },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", alias: "luna" },
  { id: "gpt-5.5", label: "GPT-5.5", alias: "gpt-5.5" },
];

const modelsFor = (provider: Provider): Known[] =>
  provider === "codex" ? CODEX_MODELS : CLAUDE_MODELS;

/** The model a topic runs on when it has picked none. */
export const defaultModel = (provider: Provider = cfg.provider): string =>
  provider === "codex" ? cfg.codexModel : cfg.claudeModel;

/** A model id as a human reads it — its display name, or the id itself. */
const displayName = (id: string, provider?: Provider): string =>
  (provider ? modelsFor(provider) : [...CLAUDE_MODELS, ...CODEX_MODELS]).find((m) => m.id === id)
    ?.label ?? id;

/** `fallback` names the model an unset choice resolves to, when we know it. */
export const modelLabel = (m: Model, fallback?: string, provider?: Provider): string =>
  m
    ? displayName(m, provider)
    : fallback
      ? `${displayName(fallback, provider)} (default)`
      : "default";

/** Parse a `/model <name>` argument. `undefined` = not a model we can use. */
export function parseModel(raw: string, provider: Provider = cfg.provider): Model | undefined {
  const v = raw.trim();
  const lower = v.toLowerCase();
  if (lower === "default" || lower === "reset" || lower === "-") return null;
  const known = modelsFor(provider).find(
    (m) => m.alias === lower || m.id.toLowerCase() === lower,
  );
  if (known) return known.id;
  // An id we don't list is still a model the CLI may well accept — pass it on
  // rather than making the button list the limit of what can be run.
  const valid = provider === "claude" ? /^claude-[a-z0-9.[\]_-]+$/i : /^[a-z0-9][a-z0-9.[\]_-]+$/i;
  return valid.test(v) ? v : undefined;
}

/** A picked button back into a model — the keyboard only carries real ids. */
export const asModel = (v: PickValue): Model => v ?? null;

export const modelUsage = (provider: Provider): string =>
  `⚠️ unknown model. Use one of: ${modelsFor(provider)
    .map((m) => m.alias)
    .join(", ")}, default — or a full model id.`;

/**
 * The known models, tick on the one in force. The provider model from env is the
 * default and gets its own button when it isn't one of the listed ids, so the
 * tick always has somewhere to sit.
 */
export function modelGroup(initial: Model, provider: Provider = cfg.provider): PickGroup {
  const fallback = defaultModel(provider);
  const known = modelsFor(provider).map((m) => ({ value: m.id, label: m.label }));
  const options = known.some((o) => o.value === fallback)
    ? known
    : [{ value: fallback, label: displayName(fallback, provider) }, ...known];
  return {
    key: "m",
    options,
    perRow: 2,
    initial,
    fallback,
    summary: (v) => `🤖 model: ${modelLabel(asModel(v), fallback, provider)}`,
  };
}
