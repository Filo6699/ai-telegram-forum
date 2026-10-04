import type { PlanLimits } from "../sessions/limits.ts";
import { bar, humanUntil } from "../shared/fmt.ts";

/**
 * The meter block for `/usage`, in the CLI's spirit: one bar per window.
 * Telegram only keeps columns aligned inside a code block, so that's where the
 * bars live — the label column is padded to the widest label.
 */
export function planLimitsText(limits: PlanLimits | null, provider = "Claude"): string {
  if (!limits) return "_plan limits unavailable (API key or 3rd-party provider)_";
  if (!limits.windows.length) return "_no plan limit windows reported_";
  const pad = Math.max(...limits.windows.map((w) => w.label.length));
  const rows = limits.windows.map((w) => {
    const used = w.utilization === null ? "   ?" : `${Math.round(w.utilization)}%`.padStart(4);
    const reset = w.resetsAt ? `  ⟳ ${humanUntil(w.resetsAt)}` : "";
    return `${w.label.padEnd(pad)} ${bar(w.utilization)} ${used}${reset}`;
  });
  const plan = limits.subscription ? ` (${limits.subscription})` : "";
  return [`⏳ *${provider} plan${plan}*`, "```", ...rows, "```"].join("\n");
}
