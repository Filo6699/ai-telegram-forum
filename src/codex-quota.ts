import type { ServiceTier } from "./preset-config.ts";

/**
 * POC calibration from the local Pro weekly window on 2026-08-31. OpenAI does
 * not publish the included weekly capacity, so unlike the per-model rates this
 * denominator is deliberately an estimate.
 */
const WEEKLY_CREDITS_ESTIMATE = 9_000;

interface CreditRate {
  input: number;
  cachedInput: number;
  output: number;
  fastMultiplier: number;
}

/** Official ChatGPT Codex credits per million tokens. */
const CREDIT_RATES: Record<string, CreditRate> = {
  "gpt-5.6-sol": { input: 100, cachedInput: 10, output: 500, fastMultiplier: 2.5 },
  "gpt-5.6-terra": { input: 50, cachedInput: 5, output: 300, fastMultiplier: 2.5 },
  "gpt-5.6-luna": { input: 5, cachedInput: 0.5, output: 30, fastMultiplier: 2.5 },
  "gpt-5.5": { input: 125, cachedInput: 12.5, output: 750, fastMultiplier: 2.5 },
  "gpt-5.4-mini": { input: 18.75, cachedInput: 1.875, output: 113, fastMultiplier: 2 },
  "gpt-5.4": { input: 62.5, cachedInput: 6.25, output: 375, fastMultiplier: 2 },
};

export interface CodexTokenBreakdown {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
}

function creditRate(model: string): CreditRate | null {
  const id = model.trim().toLowerCase();
  const base = Object.keys(CREDIT_RATES)
    .filter((candidate) => id === candidate || id.startsWith(`${candidate}-`))
    .sort((a, b) => b.length - a.length)[0];
  return (base && CREDIT_RATES[base]) || null;
}

/** Estimate one native response in the same credits OpenAI's rate card uses. */
export function estimateCodexCredits(
  usage: CodexTokenBreakdown,
  model: string,
  serviceTier: ServiceTier,
): number | null {
  const rate = creditRate(model);
  if (!rate) return null;

  const input = Number(usage.input_tokens ?? 0);
  const cached = Math.min(input, Math.max(0, Number(usage.cached_input_tokens ?? 0)));
  const output = Math.max(0, Number(usage.output_tokens ?? 0));
  if (![input, cached, output].every(Number.isFinite) || input < 0) return null;

  // cached_input_tokens is a subset of input_tokens. Cache writes remain in
  // ordinary input; only cache reads receive the discounted rate.
  const newInput = input - cached;
  const credits =
    (newInput * rate.input + cached * rate.cachedInput + output * rate.output) / 1_000_000;
  return credits * (serviceTier === "fast" ? rate.fastMultiplier : 1);
}

/** Estimated share of the included rolling weekly allowance. */
export const estimateCodexWeeklyPercent = (credits: number): number =>
  (Math.max(0, credits) / WEEKLY_CREDITS_ESTIMATE) * 100;

export function formatCodexWeeklyPercent(percent: number): string {
  if (percent > 0 && percent < 0.05) return "<0.1%";
  if (percent < 10) return `${percent.toFixed(1)}%`;
  return `${Math.round(percent)}%`;
}
