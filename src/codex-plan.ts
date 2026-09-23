import { compactMs } from "./fmt.ts";

export interface CodexPlanStep {
  step: string;
  status: "pending" | "inProgress" | "completed";
}

interface TrackedStep extends CodexPlanStep {
  completedAtMs: number | null;
}

const marker = (status: CodexPlanStep["status"]): string =>
  status === "completed" ? "✅" : status === "inProgress" ? "🔄" : "⬜";

/** One Codex turn's plan, retaining when each currently completed step finished. */
export class CodexTurnPlan {
  private steps: TrackedStep[] = [];

  constructor(private startedAt: number) {}

  /** Returns the first plan for immediate posting; later updates only change the final copy. */
  update(plan: CodexPlanStep[], now = Date.now()): string | null {
    if (!Array.isArray(plan) || !plan.length) return null;
    const initial = this.steps.length === 0;
    const used = new Set<TrackedStep>();

    for (const incoming of plan) {
      if (!incoming?.step?.trim()) continue;
      const step = this.steps.find(
        (item) => item.step === incoming.step && !used.has(item),
      ) ?? {
        step: incoming.step,
        status: "pending" as const,
        completedAtMs: null,
      };
      if (!this.steps.includes(step)) this.steps.push(step);
      used.add(step);
      if (incoming.status === "completed" && step.status !== "completed") {
        step.completedAtMs = Math.max(0, now - this.startedAt);
      } else if (incoming.status !== "completed") {
        step.completedAtMs = null;
      }
      step.status = incoming.status;
    }

    return initial && this.steps.length
      ? `📋 План\n${this.steps.map((step) => `- ${marker(step.status)} ${step.step}`).join("\n")}`
      : null;
  }

  finalText(): string | null {
    if (!this.steps.length) return null;
    const lines = this.steps.map((step) =>
      `- ${marker(step.status)} ${step.step}` +
      (step.status === "completed" && step.completedAtMs !== null
        ? ` — ${compactMs(step.completedAtMs)}`
        : ""),
    );
    return `📋 План (итог; время от начала хода)\n${lines.join("\n")}`;
  }
}
