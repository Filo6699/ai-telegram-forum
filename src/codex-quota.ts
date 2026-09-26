import type { ServiceTier } from "./preset-config.ts";

/**
 * Recalibrated from local Pro windows through 2026-09-11, including Astra.
 * Recent windows imply ~8,517–8,579 credits; rounded to 8,500. OpenAI does
 * not publish the included weekly capacity, so unlike the per-model rates this
 * denominator is deliberately an estimate.
 */
const WEEKLY_CREDITS_ESTIMATE = 8_500;

interface CreditRate {
  input: number;
  cachedInput: number;
  output: number;
}

/** https://developers.openai.com/codex/speed */
const FAST_MULTIPLIER = 2.5;

/** Official ChatGPT Codex credits per million tokens.
 * https://learn.chatgpt.com/docs/pricing#token-rates
 */
const CREDIT_RATES: Record<string, CreditRate> = {
  "gpt-6-astra": { input: 250, cachedInput: 25, output: 1250 },
  "gpt-6-sol": { input: 50, cachedInput: 5, output: 250 },
  "gpt-6-luna": { input: 2.5, cachedInput: 0.25, output: 12.5 },
  "gpt-5.6-sol": { input: 100, cachedInput: 10, output: 500 },
  "gpt-5.6-terra": { input: 50, cachedInput: 5, output: 300 },
  "gpt-5.6-luna": { input: 5, cachedInput: 0.5, output: 30 },
  "gpt-5.5": { input: 125, cachedInput: 12.5, output: 750 },
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
  return credits * (serviceTier === "fast" ? FAST_MULTIPLIER : 1);
}

/** Estimated share of the included rolling weekly allowance. */
export const estimateCodexWeeklyPercent = (credits: number): number =>
  (Math.max(0, credits) / WEEKLY_CREDITS_ESTIMATE) * 100;

export function formatCodexWeeklyPercent(percent: number): string {
  if (percent > 0 && percent < 0.1) return `${percent.toFixed(2)}%`;
  if (percent < 10) return `${percent.toFixed(1)}%`;
  return `${Math.round(percent)}%`;
}
