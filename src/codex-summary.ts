import { fetchCodexSessionUsage } from "./codex-session-usage.ts";
import { formatCodexWeeklyPercent } from "./codex-quota.ts";
import { fmtTokens } from "./fmt.ts";

/** Extra end-of-turn fields specific to the persisted Codex session. */
export async function codexSummaryParts(
  sessionId: string | null,
  fallbackTopicTokens: number,
): Promise<string[]> {
  let usage = null;
  try {
    usage = sessionId ? await fetchCodexSessionUsage(sessionId) : null;
  } catch (err) {
    console.warn("[summary] Codex session usage failed:", String(err));
  }

  const parts: string[] = [];
  parts.push(`Σ${fmtTokens(usage?.totalTokens ?? fallbackTopicTokens)}`);
  if (usage?.estimatedWeeklyPercent !== null && usage?.estimatedWeeklyPercent !== undefined) {
    parts.push(`🧠≈${formatCodexWeeklyPercent(usage.estimatedWeeklyPercent)}`);
  }
  return parts;
}
