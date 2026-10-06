import type { CodexTokenBreakdown } from "./quota.ts";

export interface CodexTokenUsage extends CodexTokenBreakdown {
  total_tokens?: number;
}

/** A token_count notification can repeat the previous response (for example
 * when only rate limits change). The cumulative counters identify new usage;
 * identical last-response sizes alone do not identify duplicates. */
export class CodexResponseUsage {
  private previousTotal: string | null = null;
  inputTokens = 0;
  outputTokens = 0;
  totalTokens = 0;

  add(last: CodexTokenUsage, total?: CodexTokenUsage): boolean {
    if (total) {
      const key = JSON.stringify([
        total.input_tokens, total.cached_input_tokens, total.output_tokens, total.total_tokens,
      ]);
      if (key === this.previousTotal) return false;
      this.previousTotal = key;
    }
    this.inputTokens += Math.max(0, last.input_tokens ?? 0);
    this.outputTokens += Math.max(0, last.output_tokens ?? 0);
    this.totalTokens += Math.max(0, last.total_tokens ??
      ((last.input_tokens ?? 0) + (last.output_tokens ?? 0)));
    return true;
  }
}
