/**
 * First-party API prices in USD per million tokens. They only serve as a
 * common unit for weighting a session's tokens against the weekly limit; a
 * subscription is not billed per token.
 */
interface Rate {
  input: number;
  output: number;
  cacheRead: number;
  /** Fast mode multiplier, when the model has one. */
  fast?: number;
}

const r = (input: number, output: number, cacheRead: number, fast?: number): Rate => ({
  input,
  output,
  cacheRead,
  ...(fast ? { fast } : {}),
});

/** Longest matching prefix wins, so `claude-fable-5-1` beats `claude-fable-5`. */
const RATES: Record<string, Rate> = {
  "claude-fable-5-1": r(10, 50, 0.25),
  "claude-mythos-5-1": r(10, 50, 0.25),
  "claude-fable-5": r(10, 50, 1),
  "claude-mythos-5": r(10, 50, 1),
  "claude-opus-5-5": r(4, 20, 0.2, 2),
  "claude-opus-5": r(5, 25, 0.5, 2),
  "claude-opus-4-8": r(5, 25, 0.5),
  "claude-opus-4-7": r(5, 25, 0.5),
  "claude-opus-4-6": r(5, 25, 0.5),
  "claude-opus-4-5": r(5, 25, 0.5),
  "claude-opus-4": r(15, 75, 1.5),
  "claude-sonnet-5-5": r(2, 10, 0.2),
  "claude-sonnet-5": r(2, 10, 0.2),
  "claude-sonnet-4": r(3, 15, 0.3),
  "claude-haiku-5-5": r(0.1, 0.5, 0.01),
  "claude-haiku-4-5": r(1, 5, 0.1),
};

/** Claude Haiku 5.5 charges five times more once the prompt passes 100K tokens. */
const HAIKU_LONG_PROMPT = 100_000;

export interface ClaudeTokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  } | null;
  speed?: string | null;
}

function rate(model: string): Rate | null {
  const id = model.trim().toLowerCase().replace(/\[.*\]$/, "");
  const key = Object.keys(RATES)
    .filter((k) => id === k || id.startsWith(`${k}-`))
    .sort((a, b) => b.length - a.length)[0];
  return key ? RATES[key]! : null;
}

const n = (v: unknown): number => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) && x > 0 ? x : 0;
};

/** API-equivalent cost of one response, or null for a model without a known price. */
export function claudeResponseCost(usage: ClaudeTokenUsage, model: string): number | null {
  const base = rate(model);
  if (!base) return null;
  const input = n(usage.input_tokens);
  const output = n(usage.output_tokens);
  const read = n(usage.cache_read_input_tokens);
  const written = n(usage.cache_creation_input_tokens);
  const w1h = Math.min(written, n(usage.cache_creation?.ephemeral_1h_input_tokens));
  const w5m = written - w1h;

  let { input: inRate, output: outRate, cacheRead: readRate } = base;
  if (model.includes("haiku-5-5") && input + read + written > HAIKU_LONG_PROMPT) {
    inRate *= 5;
    outRate *= 5;
    readRate *= 5;
  }
  const cost =
    (input * inRate + w5m * inRate * 1.25 + w1h * inRate * 2 + read * readRate + output * outRate) /
    1_000_000;
  return usage.speed === "fast" && base.fast ? cost * base.fast : cost;
}
