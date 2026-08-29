import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { LimitWindow, PlanLimits } from "./limits.ts";

const codexCli = fileURLToPath(new URL("../node_modules/@openai/codex/bin/codex.js", import.meta.url));
const ASK_TIMEOUT_MS = 60_000;

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
export function fetchCodexPlanLimits(): Promise<PlanLimits | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [codexCli, "app-server", "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = createInterface({ input: child.stdout });
    let stderr = "";
    let settled = false;

    const finish = (error?: unknown, value?: PlanLimits | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.kill();
      if (error) reject(error);
      else resolve(value ?? null);
    };
    const timer = setTimeout(
      () => finish(new Error(`Codex plan limits timed out after ${ASK_TIMEOUT_MS}ms`)),
      ASK_TIMEOUT_MS,
    );

    child.stderr.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-4000);
    });
    child.on("error", finish);
    child.on("exit", (code) => {
      if (!settled) {
        finish(new Error(`Codex app-server exited ${code ?? "without a code"}: ${stderr.trim()}`));
      }
    });
    lines.on("line", (line) => {
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id === 1 && message.result) {
        child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
        child.stdin.write(`${JSON.stringify({ id: 2, method: "account/rateLimits/read" })}\n`);
      } else if (message.id === 1 && message.error) {
        finish(new Error(message.error.message ?? "Codex app-server initialization failed"));
      } else if (message.id === 2 && message.error) {
        finish(new Error(message.error.message ?? "Codex rate limits unavailable"));
      } else if (message.id === 2) {
        finish(undefined, mapLimits(message.result ?? {}));
      }
    });

    child.stdin.write(
      `${JSON.stringify({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: {
            name: "claude-tg-forum",
            title: "Telegram broker",
            version: "0.1.0",
          },
          capabilities: { experimentalApi: true },
        },
      })}\n`,
    );
  });
}
