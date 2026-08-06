import { query } from "@anthropic-ai/claude-agent-sdk";
import { cfg } from "./config.ts";
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
  add("5-hour", r.five_hour);
  add("weekly", r.seven_day);
  add("weekly · Opus", r.seven_day_opus);
  add("weekly · Sonnet", r.seven_day_sonnet);
  for (const m of r.model_scoped ?? []) add(`weekly · ${m.display_name}`, m);

  return { subscription: usage.subscription_type ?? null, windows };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then(resolve, reject).finally(() => clearTimeout(t));
  });
}
