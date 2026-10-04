/** One rate-limit window reported by an agent provider. */
export interface LimitWindow {
  label: string;
  utilization: number | null;
  resetsAt: string | null;
}

export interface PlanLimits {
  subscription: string | null;
  windows: LimitWindow[];
}
