import { fetchCodexSessionUsage } from "./codex-session-usage.ts";
import { formatCodexWeeklyPercent } from "./codex-quota.ts";

/** Raw estimated session spend, used to take a per-turn baseline. */
export async function codexWeeklyPercent(sessionId: string | null): Promise<number | null> {
  if (!sessionId) return null;
  try {
    return (await fetchCodexSessionUsage(sessionId))?.estimatedWeeklyPercent ?? null;
  } catch (err) {
    console.warn("[summary] Codex session usage failed:", String(err));
    return null;
  }
}

export function formatCodexWeeklyPart(
  total: number,
  turnBaseline: number | null = null,
): string {
  const session = formatCodexWeeklyPercent(total);
  if (turnBaseline === null) return `🧠 ${session}`;
  const turn = formatCodexWeeklyPercent(Math.max(0, total - turnBaseline));
  return `🧠 ${turn} | ${session}`;
}

/** Compact estimated weekly spend for one persisted Codex session. */
export async function codexWeeklyPart(
  sessionId: string | null,
  turnBaseline: number | null = null,
): Promise<string | null> {
  const total = await codexWeeklyPercent(sessionId);
  if (total === null) return null;
  return formatCodexWeeklyPart(total, turnBaseline);
}

/** Extra end-of-turn fields specific to the persisted Codex session. */
export async function codexSummaryParts(
  sessionId: string | null,
  turnBaseline: number | null = null,
): Promise<string[]> {
  const weekly = await codexWeeklyPart(sessionId, turnBaseline);
  return weekly ? [weekly] : [];
}
