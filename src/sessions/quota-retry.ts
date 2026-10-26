import type { PlanLimits } from "./limits.ts";

export const QUOTA_CHECK_MS = 20 * 60_000;
export const QUOTA_CONTINUATION = "Continue the previous request after the subscription usage limit. Check the existing progress and history before continuing; do not repeat completed actions.";

/** Subscription exhaustion, rather than a transient API throttle or billing failure. */
export function isQuotaFailure(failure: string | null): boolean {
  return Boolean(failure && /\b(?:usage[_ ]limit(?:[_ ]reached)?|(?:subscription|weekly|five.hour|5.hour|7.day)\s+(?:usage\s+)?limit|quota\s+(?:exceeded|exhausted)|(?:hit|reached|exceeded)\s+your\s+(?:usage\s+)?limit)\b/i.test(failure));
}

/** Only the selected model's windows can prevent this task from continuing. */
export function quotaStatus(limits: PlanLimits | null, now = Date.now(), model: string | null = null) {
  const windows = (limits?.windows ?? []).filter(w => !w.modelFamily || !model || model.toLowerCase().includes(w.modelFamily.toLowerCase()));
  const blocked = windows.filter(w => w.utilization !== null && w.utilization >= 100);
  const resets = blocked.map(w => Date.parse(w.resetsAt ?? "")).filter(t => Number.isFinite(t) && t > now);
  // Both the short and weekly windows must recover; the later reset wins.
  const resetAt = resets.length ? Math.max(...resets) : null;
  return {
    ready: windows.length > 0 && windows.every(w => w.utilization !== null && w.utilization < 100),
    blocked: blocked.length > 0,
    resetAt,
    delay: resetAt === null ? QUOTA_CHECK_MS : Math.min(QUOTA_CHECK_MS, resetAt - now),
  };
}
