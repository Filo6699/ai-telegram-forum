/** One rate-limit window reported by an agent provider. */
export interface LimitWindow {
  label: string;
  utilization: number | null;
  resetsAt: string | null;
  /** A model-specific allowance; absent for account-wide windows. */
  modelFamily?: string;
}

export interface PlanLimits {
  subscription: string | null;
  windows: LimitWindow[];
}
