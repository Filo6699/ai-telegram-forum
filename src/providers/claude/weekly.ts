import {
  addClaudeWeeklySample,
  claudeWeeklySamples,
  getSetting,
  setSetting,
  type ClaudeWeeklySample,
} from "../../storage/db.ts";
import { claudeAccountSpend, claudeSessionSpend } from "./transcripts.ts";
import { formatWeeklyPercent } from "../../shared/fmt.ts";

/**
 * Estimated share of the Claude weekly limit spent by one session.
 *
 * Anthropic reports only the account-wide weekly percent, in whole numbers,
 * and never says how big a week is. The bot learns the size instead: it pairs
 * each reported percent with the API-equivalent dollars found in local
 * transcripts since the window opened, and derives "dollars per 1%".
 *
 * Guards against a jumpy estimate:
 * - A ratio comes only from a span over which the percent rose by at least
 *   MIN_SPAN_POINTS, so whole-number rounding moves it by ~10% at most.
 * - Usage the bot cannot see (claude.ai, another machine) only ever makes a
 *   span's ratio too low, so the estimate takes an upper quantile of spans.
 * - The stored ratio moves at most ×MAX_STEP per newly closed span.
 * - Until calibrated, it shows an upper bound instead (see `lowerBound`).
 */

const WEEK_MS = 7 * 24 * 3600_000;
const MIN_SPAN_POINTS = 10;
const MIN_CALIBRATED_POINTS = 10;
const HISTORY_SPANS = 12;
const QUANTILE = 0.75;
const MAX_STEP = 1.25;
const LOOKBACK_MS = 8 * WEEK_MS;
/** Old enough to survive a weekly reset, recent enough to follow a plan change. */
const BOUND_LOOKBACK_MS = 2 * WEEK_MS;
const SETTING = "claude_weekly_calibration";

export interface WeeklySpan {
  end: number;
  points: number;
  usd: number;
}

export interface WeeklyCalibration {
  usdPerPercent: number;
  plan: string | null;
  /** End of the newest span folded in; a span is used once. */
  lastSpanEnd: number;
  points: number;
  spans: number;
}

/** Windows are keyed to the hour: `resets_at` jitters by a second or so. */
const windowKey = (resetsAt: number): number => Math.round(resetsAt / 3600_000);

/**
 * Split samples into spans of ≥ MIN_SPAN_POINTS within one weekly window. Each
 * window starts from a known anchor: zero percent and zero dollars.
 */
export function buildSpans(samples: ClaudeWeeklySample[], plan: string | null): WeeklySpan[] {
  const byWindow = new Map<number, ClaudeWeeklySample[]>();
  for (const s of samples) {
    if (s.plan !== plan) continue;
    const key = windowKey(s.resets_at);
    byWindow.set(key, [...(byWindow.get(key) ?? []), s]);
  }
  const spans: WeeklySpan[] = [];
  for (const window of byWindow.values()) {
    window.sort((a, b) => a.at - b.at);
    let anchor = { at: window[0]!.resets_at - WEEK_MS, utilization: 0, local_usd: 0 };
    for (const s of window) {
      const points = s.utilization - anchor.utilization;
      const usd = s.local_usd - anchor.local_usd;
      // A drop means the window was reset or re-based under us; start over.
      if (points < 0 || usd < 0) {
        anchor = s;
        continue;
      }
      if (points < MIN_SPAN_POINTS) continue;
      // Percent rose with nothing spent here: someone else's usage. Skip it.
      if (usd > 0) spans.push({ end: s.at, points, usd });
      anchor = s;
    }
  }
  return spans.sort((a, b) => a.end - b.end);
}

function quantile(sorted: number[], q: number): number {
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
}

/** Fold newly closed spans into the stored ratio, damped. */
export function calibrate(
  spans: WeeklySpan[],
  plan: string | null,
  prev: WeeklyCalibration | null,
): WeeklyCalibration | null {
  const recent = spans.slice(-HISTORY_SPANS);
  const points = recent.reduce((n, s) => n + s.points, 0);
  if (!recent.length || points < MIN_CALIBRATED_POINTS) return prev?.plan === plan ? prev : null;
  const last = recent[recent.length - 1]!.end;
  const same = prev?.plan === plan ? prev : null;
  if (same && last <= same.lastSpanEnd) return same;

  const ratios = recent.map((s) => s.usd / s.points).sort((a, b) => a - b);
  let usdPerPercent = quantile(ratios, QUANTILE);
  if (same) {
    usdPerPercent = Math.min(same.usdPerPercent * MAX_STEP, Math.max(same.usdPerPercent / MAX_STEP, usdPerPercent));
  }
  return { usdPerPercent, plan, lastSpanEnd: last, points, spans: recent.length };
}

/**
 * The endpoint rounds to the nearest whole percent, so a reading of u means
 * the true share is below u + 0.5. Local dollars can only be part of that
 * share, so 1% costs at least S / (u + 0.5), whatever other devices spent.
 * Each sample is a hard floor; the largest one wins and only ever grows, so
 * percentages derived from it only ever come down.
 */
export function lowerBound(samples: ClaudeWeeklySample[], plan: string | null): number | null {
  let best = 0;
  for (const s of samples) {
    if (s.plan !== plan || s.local_usd <= 0) continue;
    best = Math.max(best, s.local_usd / (s.utilization + 0.5));
  }
  return best > 0 ? best : null;
}

export interface WeeklyRatio {
  usdPerPercent: number;
  /** false: only the floor is known, so percentages are upper bounds. */
  calibrated: boolean;
}

/** The dollars-per-1% figure to estimate with, or null with no data at all. */
export function claudeWeeklyRatio(now = Date.now()): WeeklyRatio | null {
  const cal = claudeWeeklyCalibration();
  const samples = claudeWeeklySamples(now - BOUND_LOOKBACK_MS);
  const plan = cal?.plan ?? samples[samples.length - 1]?.plan ?? null;
  const floor = lowerBound(samples, plan);
  if (cal) return { usdPerPercent: Math.max(cal.usdPerPercent, floor ?? 0), calibrated: true };
  return floor ? { usdPerPercent: floor, calibrated: false } : null;
}

export function claudeWeeklyCalibration(): WeeklyCalibration | null {
  const raw = getSetting(SETTING);
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as WeeklyCalibration;
    return Number.isFinite(c.usdPerPercent) && c.usdPerPercent > 0 ? c : null;
  } catch {
    return null;
  }
}

const toMs = (v: unknown): number | null => {
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
};

/** Record one reading of the account's weekly window and recalibrate. */
export function recordClaudeWeeklySample(
  utilization: unknown,
  resetsAt: unknown,
  plan: string | null,
  now = Date.now(),
): void {
  const reset = toMs(resetsAt);
  const u = Number(utilization);
  if (reset === null || !Number.isFinite(u) || u < 0 || reset <= now) return;
  const spend = claudeAccountSpend(reset - WEEK_MS, now);
  addClaudeWeeklySample({ at: now, resets_at: reset, utilization: u, local_usd: spend.usd, plan });

  const spans = buildSpans(claudeWeeklySamples(now - LOOKBACK_MS), plan);
  const prev = claudeWeeklyCalibration();
  const next = calibrate(spans, plan, prev);
  if (!next && prev) setSetting(SETTING, "");
  if (next && next !== prev) {
    setSetting(SETTING, JSON.stringify(next));
    console.log(
      `[weekly] Claude calibration: $${next.usdPerPercent.toFixed(2)} per 1% ` +
        `(${next.spans} spans, ${next.points} points)`,
    );
  }
}

/** A session's API-equivalent dollars so far, or null without a transcript. */
export function claudeSessionUsd(sessionId: string | null): number | null {
  if (!sessionId) return null;
  try {
    return claudeSessionSpend(sessionId)?.usd ?? null;
  } catch (err) {
    console.warn("[weekly] reading Claude session spend failed:", String(err));
    return null;
  }
}

/**
 * `🧠 ≈turn | ≈session` against the calibrated week, or `≤` while only the
 * floor is known. The ratio is taken once per turn by the caller, so one
 * turn's numbers never move under it.
 */
export function claudeWeeklyPart(
  sessionUsd: number | null,
  turnBaselineUsd: number | null,
  ratio: WeeklyRatio | null,
): string | null {
  if (sessionUsd === null || !ratio) return null;
  const mark = ratio.calibrated ? "≈" : "≤";
  const session = formatWeeklyPercent(sessionUsd / ratio.usdPerPercent);
  if (turnBaselineUsd === null) return `🧠 ${mark}${session}`;
  const turn = formatWeeklyPercent(Math.max(0, sessionUsd - turnBaselineUsd) / ratio.usdPerPercent);
  return `🧠 ${mark}${turn} | ${mark}${session}`;
}
