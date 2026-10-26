import { query } from "@anthropic-ai/claude-agent-sdk";
import { cfg } from "../../config/env.ts";
import type { LimitWindow, PlanLimits } from "../../sessions/limits.ts";
import { recordClaudeWeeklySample } from "./weekly.ts";

const ASK_TIMEOUT_MS = 60_000;
/** Turn-end readings feed the weekly calibration; more often adds nothing. */
const SAMPLE_INTERVAL_MS = 3 * 60_000;
let lastSample = 0;

/**
 * The plan's own 5-hour and weekly limits — the numbers `/usage` shows in the
 * CLI, not this bot's token accounting.
 *
 * A live topic session can answer over its control channel for free; when no
 * topic is warm, a throwaway session is started just for the question and shut
 * down again. Its prompt iterator never yields, so the child costs a process,
 * not a turn.
 */
export async function fetchPlanLimits(live: Asker | null = null): Promise<PlanLimits | null> {
  if (live) return read(live);

  const abort = new AbortController();
  const q = query({
    prompt: (async function* () {
      await new Promise<void>((resolve) => abort.signal.addEventListener("abort", () => resolve()));
    })(),
    options: {
      model: cfg.claudeModel,
      permissionMode: "default",
      abortController: abort,
      stderr: () => {},
    },
  });
  try {
    return await read(q);
  } finally {
    abort.abort();
    void q.return(undefined).catch(() => {});
  }
}

/**
 * Read the plan limits over a live session's control channel, at most every
 * few minutes, only to feed the weekly calibration. Never starts a process.
 */
export async function sampleClaudeWeekly(live: Asker | null): Promise<void> {
  if (!live || Date.now() - lastSample < SAMPLE_INTERVAL_MS) return;
  lastSample = Date.now();
  try {
    await read(live);
  } catch (err) {
    console.warn("[weekly] sampling Claude limits failed:", String(err));
  }
}

type Asker = { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(): Promise<any> };

async function read(q: Asker): Promise<PlanLimits | null> {
  const usage = await withTimeout(
    q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(),
    ASK_TIMEOUT_MS,
  );
  // API-key, Bedrock and Vertex sessions have no plan limits to report.
  if (!usage?.rate_limits_available || !usage.rate_limits) return null;

  const r = usage.rate_limits;
  const plan = usage.subscription_type ?? null;
  try {
    if (r.seven_day?.utilization != null) {
      recordClaudeWeeklySample(r.seven_day.utilization, r.seven_day.resets_at, plan);
    }
  } catch (err) {
    console.warn("[weekly] recording a Claude sample failed:", String(err));
  }
  const windows: LimitWindow[] = [];
  const add = (label: string, w: any, modelFamily?: string) => {
    if (w && (w.utilization !== null || w.resets_at)) {
      windows.push({ label, utilization: w.utilization ?? null, resetsAt: w.resets_at ?? null, ...(modelFamily ? { modelFamily } : {}) });
    }
  };
  add("Session (5h)", r.five_hour);
  add("Week (all)", r.seven_day);
  add("Week (Opus)", r.seven_day_opus, "opus");
  add("Week (Sonnet)", r.seven_day_sonnet, "sonnet");
  for (const m of r.model_scoped ?? []) add(`Week (${m.display_name})`, m, /opus|sonnet|haiku/i.exec(m.display_name)?.[0]?.toLowerCase());

  return { subscription: plan, windows };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then(resolve, reject).finally(() => clearTimeout(t));
  });
}
