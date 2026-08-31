import { fetchCodexPlanLimits } from "./codex-limits.ts";
import { fetchCodexSessionUsage } from "./codex-session-usage.ts";
import { fmtTokens, humanUntil } from "./fmt.ts";
import type { PlanLimits } from "./limits.ts";

export function compactCodexLimits(limits: PlanLimits | null): string | null {
  const windows = (limits?.windows ?? []).flatMap((window) => {
    const match = /^Codex \((.+)\)$/.exec(window.label);
    return match ? [{ ...window, duration: match[1]! }] : [];
  });
  if (!windows.length) return null;
  return windows
    .map((window) => {
      const used = window.utilization === null ? "?" : `${Math.round(window.utilization)}%`;
      const reset = window.resetsAt ? ` ↻ ${humanUntil(window.resetsAt)}` : "";
      return `${window.duration} ${used}${reset}`;
    })
    .join(" / ");
}

/** Extra end-of-turn fields specific to the persisted Codex session/account. */
export async function codexSummaryParts(
  sessionId: string | null,
  fallbackTopicTokens: number,
): Promise<string[]> {
  const [sessionResult, limitsResult] = await Promise.allSettled([
    sessionId ? fetchCodexSessionUsage(sessionId) : Promise.resolve(null),
    fetchCodexPlanLimits(),
  ]);
  if (sessionResult.status === "rejected") {
    console.warn("[summary] Codex session usage failed:", String(sessionResult.reason));
  }
  if (limitsResult.status === "rejected") {
    console.warn("[summary] Codex plan limits failed:", String(limitsResult.reason));
  }

  const usage = sessionResult.status === "fulfilled" ? sessionResult.value : null;
  const parts: string[] = [];
  if (usage?.contextUsedPercent !== null && usage?.contextUsedPercent !== undefined) {
    parts.push(`📚 ${usage.contextUsedPercent}% ctx`);
  }
  parts.push(`Σ ${fmtTokens(usage?.totalTokens ?? fallbackTopicTokens)}`);

  const limits = compactCodexLimits(
    limitsResult.status === "fulfilled" ? limitsResult.value : null,
  );
  if (limits) parts.push(`⏳ ${limits}`);
  return parts;
}
