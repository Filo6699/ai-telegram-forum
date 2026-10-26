import assert from "node:assert/strict";
import test from "node:test";
import { QUOTA_CHECK_MS, isQuotaFailure, quotaStatus } from "../src/sessions/quota-retry.ts";
import { QuotaRecovery, registerQuotaButtons } from "../src/telegram/quota.ts";
import { TopicRenderer } from "../src/telegram/render.ts";
import { cfg } from "../src/config/env.ts";
import { createTopic } from "../src/storage/db.ts";
import type { PlanLimits } from "../src/sessions/limits.ts";
import type { AgentSessionOptions, AgentTurnResult } from "../src/sessions/types.ts";
import { CodexAgentSession } from "../src/providers/codex/session.ts";
import { ClaudeAgentSession } from "../src/providers/claude/session.ts";
import { CodexAppServerClient, type AppServerNotification } from "../src/providers/codex/app-server-client.ts";
import { TopicSession } from "../src/sessions/topic.ts";

const failure = "You've hit your usage limit. Try again later.";
const tick = () => new Promise<void>(setImmediate);
async function until(condition: () => boolean) {
  for (let n = 0; n < 100; n++) { if (condition()) return; await tick(); }
  assert.fail("condition was not reached");
}
const limits = (percent: number, reset = Date.now() + 5 * 60 * 60_000): PlanLimits => ({
  subscription: "test", windows: [{ label: "5h", utilization: percent, resetsAt: new Date(reset).toISOString() }],
});
let nextTopic = 15000;
function harness(provider: "codex" | "claude" = "codex") {
  const threadId = nextTopic++;
  createTopic({ threadId, cwd: "/tmp", title: "Quota test", provider });
  const messages: { id: number; text: string; options: any }[] = [];
  const edits: { id: number; text: string }[] = [];
  const markups: { id: number; options: any }[] = [];
  const api = {
    async sendMessage(_chat: number, text: string, options: any) {
      const id = messages.length + 1;
      messages.push({ id, text, options });
      return { message_id: id };
    },
    async editMessageText(_chat: number, id: number, text: string) { edits.push({ id, text }); return true; },
    async editMessageReplyMarkup(_chat: number, id: number, options: any) { markups.push({ id, options }); return true; },
  };
  const bot = { api } as any;
  let snapshot: PlanLimits | null = limits(100);
  let reads = 0;
  let retries = 0;
  let onRetry = async () => true;
  let onRead = async () => snapshot;
  const recovery = new QuotaRecovery(bot, threadId, new TopicRenderer(api as any, cfg.chatId, threadId),
    async () => { reads++; return onRead(); }, async () => { retries++; return onRetry(); }, () => "claude-sonnet-4-6");
  const results: AgentTurnResult[] = [];
  const opts: AgentSessionOptions = {
    bot, threadId, cwd: "/tmp", provider, sessionId: null, model: "model-a", effort: null,
    serviceTier: null, openrouter: null,
    channel: { sent: 0, resetSent() {} } as any,
    hooks: { async beginTurn() {}, session() {}, text() {}, tool() {}, async endTurn(r) { results.push(r); } },
  };
  return { threadId, bot, messages, edits, markups, recovery, results, opts,
    set snapshot(value: PlanLimits | null) { snapshot = value; }, get reads() { return reads; },
    get retries() { return retries; }, set onRetry(value: () => Promise<boolean>) { onRetry = value; },
    set onRead(value: () => Promise<PlanLimits | null>) { onRead = value; },
  };
}

test("subscription detection excludes transient throttles, capacity, auth, and billing errors", () => {
  for (const text of [failure, "You've hit your limit · resets 4pm", "Usage limit reached", "usage_limit_reached", "Quota exhausted", "Weekly limit exceeded"]) {
    assert.equal(isQuotaFailure(text), true, text);
  }
  for (const text of [null, "429 rate limit", "rate_limit_exceeded", "Model is at capacity", "401 invalid key", "insufficient credits", "maximum context length exceeded"]) {
    assert.equal(isQuotaFailure(text), false, text ?? "null");
  }
});

test("all applicable quota windows must recover; unrelated model limits do not block", () => {
  const now = Date.now();
  const snapshot = limits(100, now + 60_000);
  snapshot.windows.push({ label: "week", utilization: 100, resetsAt: new Date(now + 3 * QUOTA_CHECK_MS).toISOString() });
  snapshot.windows.push({ label: "Opus", modelFamily: "opus", utilization: 100, resetsAt: new Date(now + 7 * QUOTA_CHECK_MS).toISOString() });
  assert.equal(quotaStatus(snapshot, now, "sonnet").resetAt, now + 3 * QUOTA_CHECK_MS);
  assert.equal(quotaStatus(snapshot, now, "opus").resetAt, now + 7 * QUOTA_CHECK_MS);
  assert.equal(quotaStatus(snapshot, now, "sonnet").delay, QUOTA_CHECK_MS);
  snapshot.windows[0]!.utilization = 0;
  snapshot.windows[1]!.utilization = 0;
  assert.equal(quotaStatus(snapshot, now, "sonnet").ready, true);
  assert.equal(quotaStatus(null).ready, false);
  assert.equal(quotaStatus({ subscription: null, windows: [{ label: "unknown", utilization: null, resetsAt: "bad" }] }).ready, false);
});

test("wait is opt-in; free checks every 20 minutes detect early quota recovery", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const h = harness();
  t.after(() => h.recovery.clear("closed"));
  await h.recovery.offer(failure);
  assert.match(h.messages[0]!.options.reply_markup.inline_keyboard[0][0].text, /Wait and retry/);
  t.mock.timers.tick(QUOTA_CHECK_MS * 2);
  assert.equal(h.reads, 0);
  await h.recovery.start(1);
  await h.recovery.start(1);
  assert.equal(h.reads, 1);
  t.mock.timers.tick(QUOTA_CHECK_MS);
  await until(() => h.reads === 2);
  assert.equal(h.retries, 0);
  await tick();
  h.snapshot = limits(25);
  t.mock.timers.tick(QUOTA_CHECK_MS);
  await until(() => h.retries === 1);
  assert.equal(h.messages.length, 1);
});

test("reported reset wakes sooner than 20 minutes, even if the account snapshot is stale", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const h = harness();
  t.after(() => h.recovery.clear("closed"));
  h.snapshot = limits(100, Date.now() + 90_000);
  await h.recovery.offer(failure);
  await h.recovery.start(1);
  t.mock.timers.tick(89_999);
  await tick();
  assert.equal(h.retries, 0);
  t.mock.timers.tick(1);
  await until(() => h.retries === 1);
});

test("a newly postponed reset prevents retrying; both exhausted windows must recover", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const h = harness();
  t.after(() => h.recovery.clear("closed"));
  h.snapshot = limits(100, Date.now() + 60_000);
  await h.recovery.offer(failure);
  await h.recovery.start(1);
  h.snapshot = limits(100, Date.now() + 10 * QUOTA_CHECK_MS);
  t.mock.timers.tick(60_000);
  await until(() => h.reads === 2);
  await tick();
  assert.equal(h.retries, 0);
  const weeklyBlocked = limits(0);
  weeklyBlocked.windows.push({ label: "week", utilization: 100, resetsAt: new Date(Date.now() + 5 * QUOTA_CHECK_MS).toISOString() });
  h.snapshot = weeklyBlocked;
  t.mock.timers.tick(QUOTA_CHECK_MS);
  await until(() => h.reads === 3);
  assert.equal(h.retries, 0);
});

test("unavailable limits use 20-minute attempts; repeat exhaustion keeps the opt-in active", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const h = harness();
  t.after(() => h.recovery.clear("closed"));
  h.onRead = async () => { throw new Error("usage endpoint unavailable"); };
  h.onRetry = async () => { await h.recovery.offer(failure); return true; };
  await h.recovery.offer(failure);
  await h.recovery.start(1);
  assert.equal(h.retries, 0);
  t.mock.timers.tick(QUOTA_CHECK_MS);
  await until(() => h.retries === 1 && h.reads === 3);
  await tick();
  assert.equal(h.recovery.pending, true);
  t.mock.timers.tick(QUOTA_CHECK_MS);
  await until(() => h.retries === 2);
  assert.equal(h.messages.length, 1);
});

test("native reset hints are used when usage reads return no windows", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const h = harness("claude");
  t.after(() => h.recovery.clear("closed"));
  h.snapshot = null;
  await h.recovery.offer(failure, new Date(Date.now() + 45_000).toISOString());
  await h.recovery.start(1);
  t.mock.timers.tick(45_000);
  await until(() => h.retries === 1);
});

test("stop invalidates an in-flight account read and prevents late retry", async () => {
  const h = harness();
  let release!: (limits: PlanLimits | null) => void;
  h.onRead = () => new Promise(resolve => { release = resolve; });
  await h.recovery.offer(failure);
  const starting = h.recovery.start(1);
  await until(() => Boolean(release));
  assert.equal(h.recovery.clear("stopped"), true);
  release(limits(0));
  await starting;
  assert.equal(h.retries, 0);
  assert.equal(h.recovery.pending, false);
  assert.equal(h.recovery.owns(1), false);
});

test("a stopped in-flight error delivery cannot resurrect buttons", async () => {
  const h = harness();
  let release!: () => void;
  h.bot.api.sendMessage = async () => {
    await new Promise<void>(resolve => { release = resolve; });
    return { message_id: 99 };
  };
  const offering = h.recovery.offer(failure);
  await until(() => Boolean(release));
  h.recovery.clear("stopped");
  release();
  await offering;
  assert.deepEqual(h.markups.find(m => m.id === 99)!.options.reply_markup.inline_keyboard, []);
  assert.equal(h.recovery.owns(99), false);
});

class FakeServer extends CodexAppServerClient {
  calls: { method: string; params: any }[] = [];
  listeners = new Set<(n: AppServerNotification) => void>();
  rejection: Error | null = null;
  override async request<T>(method: string, params?: any): Promise<T> {
    this.calls.push({ method, params });
    if (method === "thread/start" || method === "thread/resume") return { thread: { id: "native" } } as T;
    if (method === "turn/start") {
      if (this.rejection) { const err = this.rejection; this.rejection = null; throw err; }
      return { turn: { id: `turn-${this.starts.length}` } } as T;
    }
    return {} as T;
  }
  get starts() { return this.calls.filter(c => c.method === "turn/start"); }
  override onNotification(listener: (n: AppServerNotification) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  override onRequest() { return () => {}; }
  override close() { this.listeners.clear(); }
  complete(error: string | null = failure) {
    for (const listener of this.listeners) listener({ method: "turn/completed", params: {
      threadId: "native", turn: { id: `turn-${this.starts.length}`, status: error ? "failed" : "completed", error: { message: error } },
    } });
  }
}

test("Codex accepted quota failures continue history; rejected requests preserve input and attachments", async t => {
  for (const accepted of [true, false]) {
    const h = harness();
    const server = new FakeServer();
    const agent = new CodexAgentSession(h.opts, server);
    t.after(() => agent.close());
    if (!accepted) server.rejection = new Error(failure);
    await agent.send({ text: "work with photo", images: [{ path: "/tmp/photo.png" } as any] });
    await until(() => server.starts.length === 1);
    if (accepted) server.complete();
    await until(() => h.results.length === 1);
    assert.equal(await agent.retryQuota(), true);
    await until(() => server.starts.length === 2);
    if (accepted) {
      assert.match(server.starts[1]!.params.input[0].text, /Continue the previous request/);
      assert.equal(server.starts[1]!.params.input.length, 1);
    } else assert.deepEqual(server.starts[1]!.params.input, server.starts[0]!.params.input);
    server.complete(null);
    await until(() => h.results.length === 2);
    assert.equal(await agent.retryQuota(), false);
    assert.equal(server.calls.filter(c => c.method === "thread/start").length, 1);
  }
});

test("quota topic wiring cancels waits on stop, new input, or close and protects idle sessions", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  for (const action of ["stop", "input", "close"] as const) {
    const h = harness();
    const topic = new TopicSession(h.bot, h.threadId, "/tmp", null, "codex");
    const opts = (topic as any).agent.opts as AgentSessionOptions;
    const server = new FakeServer();
    const agent = new CodexAgentSession(opts, server);
    (topic as any).agent = agent;
    (topic.quota as any).readLimits = async () => limits(100);
    (topic as any).beginTurn = async function() { this.turnActive = true; this.turnInputVersion = this.inputVersion; };
    (topic as any).endTurn = async function(r: AgentTurnResult) {
      this.turnActive = false;
      if (isQuotaFailure(r.failure)) await this.quota.offer(r.failure!);
    };
    t.after(() => topic.close());
    await topic.send({ text: "work", images: [] });
    await until(() => server.starts.length === 1);
    server.complete();
    await until(() => h.messages.length === 1);
    await topic.quota.start(1);
    t.mock.timers.tick(cfg.sessionIdleMs);
    assert.equal((topic as any).closed, false);
    if (action === "stop") assert.equal(await topic.interrupt(), true);
    if (action === "close") topic.close();
    if (action === "input") {
      await topic.send({ text: "new task", images: [] });
      await until(() => server.starts.length === 2);
      assert.match(server.starts[1]!.params.input[0].text, /new task/);
      server.complete(null);
    }
    t.mock.timers.tick(2 * QUOTA_CHECK_MS);
    await tick();
    assert.equal(await agent.retryQuota(), false);
    assert.equal(server.starts.length, action === "input" ? 2 : 1);
  }
});

test("quota callbacks authenticate user/chat/topic, pass unknown callbacks, and detach waits", async () => {
  const h = harness("claude");
  let handler: any;
  let release!: () => void;
  let calls = 0;
  registerQuotaButtons({ on(_filter: string, fn: any) { handler = fn; } } as any, async () => {
    calls++;
    await new Promise<void>(resolve => { release = resolve; });
  });
  const ctx = (user = cfg.allowedUserId, chat = cfg.chatId, thread = h.threadId, data = `quota:${h.threadId}:wait`) => ({
    from: { id: user }, callbackQuery: { data, message: { chat: { id: chat }, message_thread_id: thread, message_id: 1 } },
    async answerCallbackQuery() {},
  });
  for (const invalid of [ctx(-1), ctx(cfg.allowedUserId, -1), ctx(cfg.allowedUserId, cfg.chatId, -1)]) {
    await handler(invalid, () => assert.fail("owned callback"));
  }
  assert.equal(calls, 0);
  let passed = false;
  await handler(ctx(cfg.allowedUserId, cfg.chatId, h.threadId, "other"), () => { passed = true; });
  assert.equal(passed, true);
  await handler(ctx(), () => {});
  await until(() => calls === 1);
  release();
});

test("topic endTurn renders quota errors once with recovery buttons and clears them on success", async t => {
  const h = harness("claude");
  const topic = new TopicSession(h.bot, h.threadId, "/tmp", null, "claude");
  t.after(() => topic.close());
  (topic as any).out.hold(failure);
  const result: AgentTurnResult = { ok: false, failure, stopped: false, sent: 0, usage: { inTokens: 0, outTokens: 0, costUsd: null } };
  await (topic as any).endTurn(result);
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0]!.options.reply_markup.inline_keyboard[0][0].callback_data, /^quota:/);
  assert.equal(topic.quota.owns(1), true);
  await (topic as any).endTurn({ ...result, ok: true, failure: null });
  await tick();
  assert.equal(topic.quota.owns(1), false);
  assert.deepEqual(h.markups.at(-1)!.options.reply_markup.inline_keyboard, []);
});

test("Claude API errors with success subtype become retryable failures, retaining the native session", async t => {
  const h = harness("claude");
  const incoming: any[] = [];
  let emit!: (msg: any) => void;
  const messages: any[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  let inputs: AsyncIterator<any>;
  let starts = 0;
  const fakeQuery = ({ prompt }: any) => {
    starts++;
    inputs = prompt[Symbol.asyncIterator]();
    emit = msg => { messages.push(msg); wake?.(); wake = null; };
    const q = {
      async *[Symbol.asyncIterator]() {
        while (!closed) {
          if (!messages.length) await new Promise<void>(resolve => { wake = resolve; });
          while (messages.length) yield messages.shift();
        }
      },
    };
    return q as any;
  };
  const agent = new ClaudeAgentSession(h.opts, fakeQuery as any);
  t.after(() => { agent.close(); closed = true; wake?.(); });
  await agent.send({ text: "original task", images: [] });
  incoming.push((await inputs!.next()).value);
  emit({ type: "system", subtype: "init", session_id: "claude-native" });
  emit({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: 2_000_000_000 } });
  emit({ type: "assistant", error: "rate_limit", message: { content: [{ type: "text", text: "You've hit your limit · resets 4pm" }] } });
  emit({ type: "result", subtype: "success", is_error: true, session_id: "claude-native", result: failure, usage: {} });
  await until(() => h.results.length === 1);
  assert.equal(h.results[0]!.ok, false);
  assert.equal(isQuotaFailure(h.results[0]!.failure), true);
  assert.equal(h.results[0]!.quotaResetsAt, new Date(2_000_000_000_000).toISOString());
  assert.equal(await agent.retryQuota(), true);
  incoming.push((await inputs!.next()).value);
  assert.match(incoming[1].message.content, /Continue the previous request/);
  assert.equal(starts, 1);
  emit({ type: "result", subtype: "success", is_error: false, session_id: "claude-native", result: "done", usage: {} });
  await until(() => h.results.length === 2);
  assert.equal(h.results[1]!.ok, true);
  assert.equal(await agent.retryQuota(), false);
});

test("Claude resumes its native session when the quota error ended the child process", async t => {
  const h = harness("claude");
  const launches: any[] = [];
  const inputs: any[] = [];
  const startQuery = ({ prompt, options }: any) => {
    launches.push(options);
    const first = launches.length === 1;
    return {
      async *[Symbol.asyncIterator]() {
        inputs.push((await prompt[Symbol.asyncIterator]().next()).value);
        yield { type: "system", subtype: "init", session_id: "native-session" };
        yield { type: "result", subtype: "success", is_error: first,
          session_id: "native-session", result: first ? failure : "done", usage: {} };
      },
    } as any;
  };
  const agent = new ClaudeAgentSession(h.opts, startQuery as any);
  t.after(() => agent.close());
  await agent.send({ text: "work", images: [] });
  await until(() => h.results.length === 1 && agent.controlQuery === null);
  assert.equal(await agent.retryQuota(), true);
  await until(() => h.results.length === 2);
  assert.equal(launches.length, 2);
  assert.equal(launches[1].resume, "native-session");
  assert.match(inputs[1].message.content, /Continue the previous request/);
  assert.equal(h.results[1]!.ok, true);
});
