interface PendingGroup<T> {
  items: T[];
  timer: ReturnType<typeof setTimeout>;
}

/** Collect Telegram's separate album updates into one semantic user message. */
export class MediaGroupCollector<T> {
  private groups = new Map<string, PendingGroup<T>>();

  constructor(
    private waitMs: number,
    private onGroup: (items: T[]) => void,
    private maxItems = 10,
  ) {}

  add(id: string, item: T): void {
    const existing = this.groups.get(id);
    if (existing) {
      clearTimeout(existing.timer);
      existing.items.push(item);
      existing.timer = setTimeout(() => this.flush(id), this.waitMs);
      if (existing.items.length >= this.maxItems) this.flush(id);
      return;
    }

    const group: PendingGroup<T> = {
      items: [item],
      timer: setTimeout(() => this.flush(id), this.waitMs),
    };
    this.groups.set(id, group);
  }

  flush(id: string): void {
    const group = this.groups.get(id);
    if (!group) return;
    this.groups.delete(id);
    clearTimeout(group.timer);
    this.onGroup(group.items);
  }
}
