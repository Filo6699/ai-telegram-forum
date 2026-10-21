/** Capacity recovery never changes models or retries unrelated failures. */
export const CAPACITY_RETRY_MS = 30_000;
export const DEFAULT_CAPACITY_RETRIES = 3;

export function isCapacityFailure(failure: string | null): boolean {
  return Boolean(failure && /\b(?:model\b[^\n]*\b(?:at capacity|overloaded)|overloaded_error)\b/i.test(failure));
}

/** One cancellable wait, shared by the timer, buttons, /stop and shutdown. */
export class CapacityRetryWait {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private settle: ((retry: boolean) => void) | null = null;
  private paused = 0;

  get pending(): boolean {
    return this.settle !== null;
  }

  wait(): Promise<boolean> {
    this.finish(false);
    return new Promise((resolve) => {
      this.settle = resolve;
      this.arm();
    });
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
      this.arm();
    };
  }

  private arm(): void {
    if (!this.pending || this.paused || this.timer) return;
    this.timer = setTimeout(() => this.finish(true), CAPACITY_RETRY_MS);
  }
}
