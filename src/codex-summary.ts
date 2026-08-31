import { fetchCodexPlanLimits } from "./codex-limits.ts";
import { fetchCodexSessionUsage } from "./codex-session-usage.ts";
import { fmtTokens } from "./fmt.ts";
import type { PlanLimits } from "./limits.ts";

export function compactCodexLimits(limits: PlanLimits | null): string | null {
  const used = (limits?.windows ?? [])
    .filter((window) => /^Codex \(.+\)$/.test(window.label))
    .flatMap((window) =>
      window.utilization === null || !Number.isFinite(window.utilization)
        ? []
        : [window.utilization],
    );
  // When Codex supplies more than one shared window, the most-consumed one is
  // the useful compact warning. Labels and reset times belong in `/usage`.
  return used.length ? `${Math.round(Math.max(...used))}%` : null;
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
  parts.push(`Σ${fmtTokens(usage?.totalTokens ?? fallbackTopicTokens)}`);

  const limits = compactCodexLimits(
    limitsResult.status === "fulfilled" ? limitsResult.value : null,
  );
  if (limits) parts.push(`⏳${limits}`);
  return parts;
}
