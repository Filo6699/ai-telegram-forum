import { fetchCodexSessionUsage } from "./codex-session-usage.ts";
import { formatCodexWeeklyPercent } from "./codex-quota.ts";

/** Compact estimated weekly spend for one persisted Codex session. */
export async function codexWeeklyPart(sessionId: string | null): Promise<string | null> {
  let usage = null;
  try {
    usage = sessionId ? await fetchCodexSessionUsage(sessionId) : null;
  } catch (err) {
    console.warn("[summary] Codex session usage failed:", String(err));
  }

  if (usage?.estimatedWeeklyPercent !== null && usage?.estimatedWeeklyPercent !== undefined) {
    return `🧠 ${formatCodexWeeklyPercent(usage.estimatedWeeklyPercent)}`;
  }
  return null;
}

/** Extra end-of-turn fields specific to the persisted Codex session. */
export async function codexSummaryParts(sessionId: string | null): Promise<string[]> {
  const weekly = await codexWeeklyPart(sessionId);
  return weekly ? [weekly] : [];
}
