import { query } from "@anthropic-ai/claude-agent-sdk";
import { cfg } from "./config.ts";
import { bar, humanUntil } from "./fmt.ts";
import { anyLiveQuery } from "./session.ts";

/** One rate-limit window as claude.ai reports it. */
export interface LimitWindow {
  label: string;
  utilization: number | null;
  resetsAt: string | null;
}

export interface PlanLimits {
  subscription: string | null;
  windows: LimitWindow[];
}

const ASK_TIMEOUT_MS = 60_000;

/**
 * The plan's own 5-hour and weekly limits — the numbers `/usage` shows in the
 * CLI, not this bot's token accounting.
 *
 * A live topic session can answer over its control channel for free; when no
 * topic is warm, a throwaway session is started just for the question and shut
 * down again. Its prompt iterator never yields, so the child costs a process,
 * not a turn.
 */
export async function fetchPlanLimits(): Promise<PlanLimits | null> {
  const live = anyLiveQuery();
  if (live) return read(live);

  const abort = new AbortController();
  const q = query({
    prompt: (async function* () {
      await new Promise<void>((resolve) => abort.signal.addEventListener("abort", () => resolve()));
    })(),
    options: {
      model: cfg.model,
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

type Asker = { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(): Promise<any> };

async function read(q: Asker): Promise<PlanLimits | null> {
  const usage = await withTimeout(
    q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(),
    ASK_TIMEOUT_MS,
  );
  // API-key, Bedrock and Vertex sessions have no plan limits to report.
  if (!usage?.rate_limits_available || !usage.rate_limits) return null;

  const r = usage.rate_limits;
  const windows: LimitWindow[] = [];
  const add = (label: string, w: any) => {
    if (w && (w.utilization !== null || w.resets_at)) {
      windows.push({ label, utilization: w.utilization ?? null, resetsAt: w.resets_at ?? null });
    }
  };
  add("Session (5h)", r.five_hour);
  add("Week (all)", r.seven_day);
  add("Week (Opus)", r.seven_day_opus);
  add("Week (Sonnet)", r.seven_day_sonnet);
  for (const m of r.model_scoped ?? []) add(`Week (${m.display_name})`, m);

  return { subscription: usage.subscription_type ?? null, windows };
}

/**
 * The meter block for `/usage`, in the CLI's spirit: one bar per window.
 * Telegram only keeps columns aligned inside a code block, so that's where the
 * bars live — the label column is padded to the widest label.
 */
export function planLimitsText(limits: PlanLimits | null): string {
  if (!limits) return "_plan limits unavailable (API key or 3rd-party provider)_";
  if (!limits.windows.length) return "_no plan limit windows reported_";
  const pad = Math.max(...limits.windows.map((w) => w.label.length));
  const rows = limits.windows.map((w) => {
    const used = w.utilization === null ? "   ?" : `${Math.round(w.utilization)}%`.padStart(4);
    const reset = w.resetsAt ? `  ⟳ ${humanUntil(w.resetsAt)}` : "";
    return `${w.label.padEnd(pad)} ${bar(w.utilization)} ${used}${reset}`;
  });
  const plan = limits.subscription ? ` (${limits.subscription})` : "";
  return [`⏳ *Claude plan${plan}*`, "```", ...rows, "```"].join("\n");
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then(resolve, reject).finally(() => clearTimeout(t));
  });
}
