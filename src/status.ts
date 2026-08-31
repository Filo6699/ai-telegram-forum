import { humanMs } from "./fmt.ts";
import { gateMs, type TopicRenderer } from "./render.ts";

/**
 * How often the live line may be rewritten, by how long the turn has been
 * running. Telegram allows roughly 20 calls a minute per chat — and every topic
 * in the forum, plus the agent's own messages, draws on that same budget.
 *
 * The refresh rate is worth spending early, when the user is still watching to
 * see the turn take hold; a turn that has been grinding for twenty minutes is
 * being checked on occasionally, not watched, so it gets out of the way.
 */
const EDIT_STEPS: Array<{ after: number; every: number }> = [
  { after: 20 * 60_000, every: 3 * 60_000 },
  { after: 60_000, every: 60_000 },
  { after: 0, every: 10_000 },
];

const editInterval = (elapsedMs: number): number =>
  EDIT_STEPS.find((s) => elapsedMs >= s.after)!.every;

/** How long the turn summary is willing to sit out a rate limit. */
const SUMMARY_WAIT_MS = 60_000;

/** Tool names listed individually in the live line; the rest fold into a count. */
const NAMED_TOOLS = 3;

/**
 * One bot-owned message per turn, edited in place: a live "what is it doing
 * right now" line while the turn runs, replaced by the turn's summary when it
 * ends.
 *
 * This is why tool activity no longer needs to be relayed as chat messages —
 * the topic used to fill up with a "🔧 Bash" post per call. Edits never send a
 * push notification, so a busy turn stays silent until the agent actually
 * speaks.
 */
export class TurnStatus {
  private messageId: number | null = null;
  private readonly startedAt = Date.now();
  private counts = new Map<string, number>();
  private total = 0;
  private lastEditAt = 0;
  private lastText = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private done = false;

  constructor(
    private out: TopicRenderer,
    private detail?: () => Promise<string | null>,
  ) {}

  get toolCalls(): number {
    return this.total;
  }

  get elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  /** Post the placeholder. Called as soon as the turn starts, so the topic reacts at once. */
  async start(): Promise<void> {
    this.lastText = "⏳ …";
    this.messageId = await this.out.sendText(this.lastText, { silent: true });
    this.lastEditAt = Date.now();
    if (this.detail) this.schedule();
  }

  /** Record a tool call and refresh the line (throttled). */
  tool(name: string): void {
    this.total++;
    this.counts.set(name, (this.counts.get(name) ?? 0) + 1);
    this.schedule();
  }

  private liveText(detail: string | null = null): string {
    const top = [...this.counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, NAMED_TOOLS)
      .map(([name, n]) => (n > 1 ? `${name} ×${n}` : name));
    const rest = this.counts.size - top.length;
    if (rest > 0) top.push(`+${rest}`);
    const tools = top.length ? ` · 🔧 ${top.join(", ")}` : "";
    return `⏳ ${humanMs(this.elapsedMs)}${tools}${detail ? ` · ${detail}` : ""}`;
  }

  /**
   * Queue a refresh. Calls that land inside the interval coalesce into the one
   * pending timer, so a burst of twenty tool calls still costs a single edit —
   * and while the chat is rate-limited, the wait stretches to cover that too.
   */
  private schedule(): void {
    if (this.done || this.timer) return;
    const since = Date.now() - this.lastEditAt;
    const wait = Math.max(editInterval(this.elapsedMs) - since, gateMs());
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, Math.max(0, wait));
  }

  /** Refresh the optional provider detail immediately before editing the live line. */
  private async refresh(): Promise<void> {
    let detail: string | null = null;
    try {
      detail = (await this.detail?.()) ?? null;
    } catch (err) {
      console.warn("[status] reading live detail failed:", String(err));
    }
    // The final summary may have landed while the provider lookup was pending.
    if (!this.done) await this.flush(this.liveText(detail));
  }

  private async flush(text: string, waitMs = 0): Promise<void> {
    if (this.messageId === null) return;
    // An edit to text Telegram already shows is a wasted call against the
    // chat's budget, and it comes back as an error besides.
    if (text === this.lastText) return;
    this.lastEditAt = Date.now();
    this.lastText = text;
    if (!(await this.out.edit(this.messageId, text, waitMs))) this.lastText = "";
  }

  /**
   * Replace the live line with the turn's summary. Nothing is edited after
   * this, so a late throttled refresh can't overwrite it.
   */
  async finish(summary: string): Promise<void> {
    this.done = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.messageId === null) {
      // The placeholder never made it out — post the summary as its own message
      // rather than losing it.
      await this.out.sendText(summary, { silent: true });
      return;
    }
    // The one edit worth waiting for: it's the whole record of the turn.
    await this.flush(summary, SUMMARY_WAIT_MS);
  }
}
