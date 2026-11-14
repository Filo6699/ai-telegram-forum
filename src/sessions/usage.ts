export interface Usage {
  inTokens: number;
  outTokens: number;
  /** null means the provider did not report a price. */
  costUsd: number | null;
  /** Running totals for the whole session (Claude streaming input), not this turn's share. */
  cumulative?: boolean;
}

export const zeroUsage = (): Usage => ({ inTokens: 0, outTokens: 0, costUsd: 0 });
