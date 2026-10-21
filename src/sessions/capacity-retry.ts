/** Capacity recovery never changes models or retries unrelated failures. */
export const CAPACITY_RETRY_MS = 30_000;
export const DEFAULT_CAPACITY_RETRY_MINUTES = 3;

export function isCapacityFailure(failure: string | null): boolean {
  return Boolean(failure && /\b(?:model\b[^\n]*\b(?:at capacity|overloaded)|overloaded_error)\b/i.test(failure));
}

/** One cancellable wait, shared by the timer, buttons, /stop and shutdown. */
export class CapacityRetryWait {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private settle: ((retry: boolean) => void) | null = null;
  private paused = 0;
  private deadline: () => number = () => Infinity;
  private nextAttemptAt = 0;

  get pending(): boolean {
    return this.settle !== null;
  }

  wait(deadline: () => number = () => Infinity): Promise<boolean> {
    this.finish(false);
    this.deadline = deadline;
    this.nextAttemptAt = Date.now() + CAPACITY_RETRY_MS;
    return new Promise((resolve) => {
      this.settle = resolve;
      this.arm();
    });
  }

  /** Re-evaluate a global time budget without moving the next retry. */
  refresh(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (Date.now() >= this.deadline()) this.finish(false);
    else this.arm();
  }

  finish(retry: boolean): boolean {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const settle = this.settle;
    this.settle = null;
    settle?.(retry);
    return Boolean(settle);
  }

  /** Keep the timer stopped while a model/settings picker is open. */
  pause(): () => void {
    this.paused++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    let resumed = false;
    return () => {
      if (resumed) return;
      resumed = true;
      this.paused--;
      if (!this.paused) this.nextAttemptAt = Date.now() + CAPACITY_RETRY_MS;
      this.arm();
    };
  }

  private arm(): void {
    if (!this.pending || this.paused || this.timer) return;
    const delay = Math.max(0, Math.min(this.nextAttemptAt, this.deadline()) - Date.now());
    this.timer = setTimeout(() => this.finish(Date.now() < this.deadline()), delay);
  }
}
