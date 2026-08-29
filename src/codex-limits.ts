import { codexRequest } from "./codex-app-server.ts";
import type { LimitWindow, PlanLimits } from "./limits.ts";

interface RateWindow {
  usedPercent?: number | null;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
}

interface Snapshot {
  limitId?: string;
  limitName?: string | null;
  planType?: string | null;
  primary?: RateWindow | null;
  secondary?: RateWindow | null;
}

interface RateLimitsResult {
  rateLimits?: Snapshot | null;
  rateLimitsByLimitId?: Record<string, Snapshot> | null;
}

function durationLabel(minutes: number | null | undefined): string {
  if (!minutes) return "window";
  if (minutes === 300) return "5h";
  if (minutes === 10_080) return "week";
  if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function mapLimits(result: RateLimitsResult): PlanLimits | null {
  const byId = Object.entries(result.rateLimitsByLimitId ?? {});
  const snapshots = byId.length
    ? byId
    : result.rateLimits
      ? [[result.rateLimits.limitId ?? "codex", result.rateLimits] as const]
      : [];
  if (!snapshots.length) return null;

  const windows: LimitWindow[] = [];
  let subscription: string | null = null;
  for (const [id, snapshot] of snapshots) {
    subscription ??= snapshot.planType ?? null;
    const name = snapshot.limitName?.trim() || (id === "codex" ? "Codex" : id);
    for (const window of [snapshot.primary, snapshot.secondary]) {
      if (!window) continue;
      windows.push({
        label: `${name} (${durationLabel(window.windowDurationMins)})`,
        utilization: window.usedPercent ?? null,
        resetsAt: window.resetsAt ? new Date(window.resetsAt * 1000).toISOString() : null,
      });
    }
  }
  return { subscription, windows };
}

/** Read the same ChatGPT Codex rolling windows the CLI displays, through the
 * official local app-server protocol. No model turn or tokens are consumed. */
export async function fetchCodexPlanLimits(): Promise<PlanLimits | null> {
  return mapLimits(await codexRequest<RateLimitsResult>("account/rateLimits/read"));
}
