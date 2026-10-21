import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPACITY_RETRY_MS, CapacityRetryWait, isCapacityFailure } from "../src/sessions/capacity-retry.ts";
import { CapacityRecovery, registerCapacityButtons } from "../src/telegram/capacity.ts";
import { TopicRenderer } from "../src/telegram/render.ts";
import { cfg } from "../src/config/env.ts";
import { createTopic, getTopic, getCapacityRetryMinutes, setCapacityRetryMinutes } from "../src/storage/db.ts";
import { CodexAgentSession } from "../src/providers/codex/session.ts";
import { AppServerError, CodexAppServerClient, type AppServerNotification } from "../src/providers/codex/app-server-client.ts";
import type { AgentSessionOptions, AgentTurnResult } from "../src/sessions/types.ts";
import { capacityRetrySettingsChanged, endSession, sessionFor, TopicSession } from "../src/sessions/topic.ts";
import { askPick, PICK_WAIT_MS, registerPickerButtons } from "../src/telegram/picker.ts";

beforeEach(() => setCapacityRetryMinutes(3));

const capacity = "Selected model is at capacity. Please try a different model.";
const tick = () => new Promise<void>(setImmediate);
async function until(condition: () => boolean) {
  for (let n = 0; n < 100; n++) { if (condition()) return; await tick(); }
  assert.fail("condition was not reached");
}

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
  override onNotification(listener: (n: AppServerNotification) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  override onRequest() { return () => {}; }
  get starts() { return this.calls.filter(c => c.method === "turn/start"); }
  complete(failure: string | null = capacity, status = failure ? "failed" : "completed") {
    for (const listener of [...this.listeners]) listener({ method: "turn/completed", params: {
      threadId: "native", turn: { id: `turn-${this.starts.length}`, status, error: failure ? { message: failure } : null },
    } });
  }
  override close() { this.listeners.clear(); }
}

let nextTopic = 9000;
function harness() {
  const threadId = nextTopic++;
  createTopic({ threadId, cwd: "/tmp", title: "Retry test", provider: "codex" });
  const messages: { id: number; text: string; options: any }[] = [];
  const edits: { id: number; text: string }[] = [];
  const markups: any[] = [];
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
  const recovery = new CapacityRecovery(bot, threadId, new TopicRenderer(api as any, cfg.chatId, threadId));
  const results: AgentTurnResult[] = [];
  const opts: AgentSessionOptions = {
    bot, threadId, cwd: "/tmp", provider: "codex", sessionId: null,
    model: "model-a", effort: "high", serviceTier: null, openrouter: null,
    channel: {} as any,
    hooks: { async beginTurn() {}, session() {}, text() {}, tool() {},
      async endTurn(result) { results.push(result); },
      recoverCapacity: (failure, retries) => recovery.recover(failure, retries, true),
    },
  };
  const server = new FakeServer();
  const agent = new CodexAgentSession(opts, server);
  return { threadId, bot, recovery, results, opts, server, agent, messages, edits, markups };
}

test("capacity detection excludes rate limits, quota, authentication and ambiguous transport failures", () => {
  assert.equal(isCapacityFailure(capacity), true);
  assert.equal(isCapacityFailure("⚠️ model overloaded"), true);
  for (const failure of [null, "429 rate limit", "Usage limit reached", "401 invalid key", "connection lost", "Capacity of disk exceeded"]) {
    assert.equal(isCapacityFailure(failure), false);
  }
});

test("waits exactly 30 seconds, pauses for pickers and settles only once", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const wait = new CapacityRetryWait();
  let settled = false;
  const decision = wait.wait().then(value => { settled = true; return value; });
  t.mock.timers.tick(CAPACITY_RETRY_MS - 1);
  await tick();
  assert.equal(settled, false);
  const resume = wait.pause();
  t.mock.timers.tick(CAPACITY_RETRY_MS * 5);
  await tick();
  assert.equal(settled, false);
  resume(); resume();
  t.mock.timers.tick(CAPACITY_RETRY_MS);
  assert.equal(await decision, true);
  assert.equal(wait.finish(false), false);
  const cancelled = wait.wait();
  assert.equal(wait.finish(false), true);
  assert.equal(await cancelled, false);
});

test("main Codex turns retry within the global minute window, reuse one error message and honor model changes", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const h = harness();
  t.after(() => { h.recovery.clear("closed"); h.agent.close(); });
  setCapacityRetryMinutes(1);
  await h.agent.send({ text: "original task", images: [{ path: "/tmp/photo.png" } as any] });
  await until(() => h.server.starts.length === 1);
  h.server.complete();
  await until(() => h.recovery.pending && h.messages.length === 1);
  const buttons = h.messages[0]!.options.reply_markup.inline_keyboard.flat();
  assert.ok(buttons.some((b: any) => b.text === "Change model"));
  assert.ok(buttons.some((b: any) => /Retry settings/.test(b.text)));
  await h.agent.applySettings({ sessionId: "native", model: "model-b", effort: "low", serviceTier: "fast", openrouter: null });
  t.mock.timers.tick(CAPACITY_RETRY_MS - 1);
  await tick();
  assert.equal(h.server.starts.length, 1);
  t.mock.timers.tick(1);
  await until(() => h.server.starts.length === 2);
  assert.equal(h.server.starts[1]!.params.model, "model-b");
  assert.equal(h.server.starts[1]!.params.serviceTierForTurn, "fast");
  assert.equal(h.server.starts[1]!.params.input.length, 1);
  assert.match(h.server.starts[1]!.params.input[0].text, /Continue the previous request/);
  assert.doesNotMatch(h.server.starts[1]!.params.input[0].text, /original task/);
  h.server.complete();
  await until(() => h.recovery.pending);
  t.mock.timers.tick(CAPACITY_RETRY_MS);
  await until(() => h.edits.some(e => /window ended/.test(e.text)));
  t.mock.timers.tick(CAPACITY_RETRY_MS * 10);
  await tick();
  assert.equal(h.server.starts.length, 2);
  assert.equal(h.messages.length, 1);
  assert.equal(h.results.length, 2);
  assert.ok(h.results.every(r => r.recoveringCapacity));
});

test("zero disables automatic retries while a manual retry remains available", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const h = harness();
  t.after(() => { h.recovery.clear("closed"); h.agent.close(); });
  setCapacityRetryMinutes(0);
  await h.agent.send({ text: "work", images: [] });
  await until(() => h.server.starts.length === 1);
  h.server.complete();
  await until(() => h.messages.length === 1);
  assert.match(h.messages[0]!.text, /retries are off/);
  t.mock.timers.tick(CAPACITY_RETRY_MS * 10);
  await tick();
  assert.equal(h.server.starts.length, 1);
  assert.equal(await h.agent.retryCapacity(), true);
  await until(() => h.server.starts.length === 2);
  h.server.complete(null);
  await until(() => h.results.length === 2);
  assert.equal(await h.agent.retryCapacity(), false);
});

test("time spent on requests consumes the minute window regardless of the attempt count", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const h = harness();
  t.after(() => { h.recovery.clear("closed"); h.agent.close(); });
  setCapacityRetryMinutes(1);
  await h.agent.send({ text: "work", images: [] });
  await until(() => h.server.starts.length === 1);
  h.server.complete();
  await until(() => h.recovery.pending && h.messages.length === 1);
  t.mock.timers.tick(30_000);
  await until(() => h.server.starts.length === 2);
  // The second request itself takes 40 seconds before rejecting capacity.
  t.mock.timers.tick(40_000);
  h.server.complete();
  await until(() => h.edits.some(e => /window ended/.test(e.text)));
  assert.equal(h.recovery.pending, false);
  assert.equal(h.server.starts.length, 2);
});

test("global duration changes preserve retry cadence and use the original start time", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const h = harness();
  t.after(() => { h.recovery.clear("closed"); h.agent.close(); });
  setCapacityRetryMinutes(1);
  const first = h.recovery.recover(capacity, 0, true);
  await until(() => h.messages.length === 1);
  t.mock.timers.tick(20_000);
  setCapacityRetryMinutes(2);
  await h.recovery.settingsChanged();
  t.mock.timers.tick(10_000);
  assert.equal(await first, true);
  const second = h.recovery.recover(capacity, 1, true);
  await tick();
  t.mock.timers.tick(29_000);
  // Shorten the global window at t=59s: only one second remains.
  setCapacityRetryMinutes(1);
  await h.recovery.settingsChanged();
  t.mock.timers.tick(1_000);
  assert.equal(await second, false);
});

test("picker time counts toward the window and expiry prevents retrying after resume", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const h = harness();
  t.after(() => { h.recovery.clear("closed"); h.agent.close(); });
  setCapacityRetryMinutes(1);
  const decision = h.recovery.recover(capacity, 0, true);
  await until(() => h.messages.length === 1);
  const resume = h.recovery.pause();
  t.mock.timers.tick(65_000);
  resume();
  t.mock.timers.tick(0);
  assert.equal(await decision, false);
});

test("a slow Telegram edit cannot start an automatic retry after the deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const h = harness();
  t.after(() => { h.recovery.clear("closed"); h.agent.close(); });
  setCapacityRetryMinutes(1);
  let release!: () => void;
  h.bot.api.editMessageText = async (_chat: number, _id: number, text: string) => {
    if (text.includes("Retrying")) await new Promise<void>(resolve => { release = resolve; });
    return true;
  };
  const decision = h.recovery.recover(capacity, 0, true);
  await until(() => h.messages.length === 1);
  t.mock.timers.tick(30_000);
  await until(() => Boolean(release));
  t.mock.timers.tick(30_000);
  release();
  assert.equal(await decision, false);
});

test("settings can stop a wait immediately and an in-flight error send cannot resurrect buttons", async t => {
  const h = harness();
  t.after(() => h.agent.close());
  const decision = h.recovery.recover(capacity, 0, true);
  await until(() => h.messages.length === 1);
  setCapacityRetryMinutes(0);
  await h.recovery.settingsChanged();
  assert.equal(await decision, false);
  let release!: () => void;
  h.bot.api.sendMessage = async () => {
    await new Promise<void>(resolve => { release = resolve; });
    return { message_id: 99 };
  };
  h.recovery.clear("new input");
  setCapacityRetryMinutes(3);
  const delayed = h.recovery.recover(capacity, 0, true);
  await until(() => Boolean(release));
  h.recovery.clear("stopped");
  release();
  assert.equal(await delayed, false);
  await until(() => h.markups.some(m => m.id === 99));
  assert.deepEqual(h.markups.find(m => m.id === 99).options.reply_markup.inline_keyboard, []);
});

test("explicit capacity RPC rejection retries the original input, while unrelated failures do not retry", async t => {
  const h = harness();
  t.after(() => { h.recovery.clear("closed"); h.agent.close(); });
  h.server.rejection = new AppServerError(capacity, -32600);
  await h.agent.send({ text: "task with photo", images: [{ path: "/tmp/photo.png" } as any] });
  await until(() => h.recovery.pending);
  h.recovery.retryNow();
  await until(() => h.server.starts.length === 2);
  assert.deepEqual(h.server.starts[1]!.params.input, h.server.starts[0]!.params.input);
  h.server.complete("Authentication failed");
  await until(() => h.results.length === 2);
  assert.equal(h.results[1]!.recoveringCapacity, false);
  assert.equal(h.recovery.pending, false);
});

test("topic stop, new input and close cancel the retry instead of replaying stale work", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  for (const action of ["stop", "input", "close"] as const) {
    const h = harness();
    const topic = new TopicSession(h.bot, h.threadId, "/tmp", null, "codex");
    const opts = (topic as any).agent.opts as AgentSessionOptions;
    const agent = new CodexAgentSession(opts, h.server);
    (topic as any).agent = agent;
    // This test exercises topic lifecycle wiring, independently of native log accounting.
    (topic as any).beginTurn = async function() {
      this.turnActive = true; this.turnInputVersion = this.inputVersion;
    };
    (topic as any).endTurn = async function() { this.turnActive = false; };
    t.after(() => { topic.close(); h.agent.close(); });
    await topic.send({ text: "work", images: [] });
    await until(() => h.server.starts.length === 1);
    h.server.complete();
    await until(() => topic.capacity.pending);
    if (action === "stop") assert.equal(await topic.interrupt(), true);
    if (action === "input") {
      await topic.send({ text: "new task", images: [] });
      await until(() => h.server.starts.length === 2);
      assert.match(h.server.starts[1]!.params.input[0].text, /new task/);
      h.server.complete(null);
    }
    if (action === "close") topic.close();
    t.mock.timers.tick(CAPACITY_RETRY_MS * 2);
    await tick();
    assert.equal(h.server.starts.length, action === "input" ? 2 : 1);
    assert.equal(await topic.retryCapacity(), false);
  }
});

test("capacity buttons authenticate user/chat/topic, pass unknown callbacks and detach actions", async () => {
  const h = harness();
  let handler: any;
  let release!: () => void;
  let calls = 0;
  registerCapacityButtons({ on(_filter: string, fn: any) { handler = fn; } } as any, async () => {
    calls++;
    await new Promise<void>(resolve => { release = resolve; });
  });
  const ctx = (user = cfg.allowedUserId, chat = cfg.chatId, thread = h.threadId, data = `cap:${h.threadId}:settings`) => ({
    from: { id: user }, callbackQuery: { data, message: { chat: { id: chat }, message_thread_id: thread, message_id: 1 } },
    async answerCallbackQuery() {},
  });
  for (const invalid of [ctx(-1), ctx(cfg.allowedUserId, -1), ctx(cfg.allowedUserId, cfg.chatId, -1)]) {
    await handler(invalid, () => assert.fail("must own capacity callbacks"));
  }
  assert.equal(calls, 0);
  let passed = false;
  await handler(ctx(cfg.allowedUserId, cfg.chatId, h.threadId, "s:1"), () => { passed = true; });
  assert.equal(passed, true);
  await handler(ctx(), () => {});
  await until(() => calls === 1);
  release();
  h.agent.close();
});

test("retry duration is global, bounded to 0–60 minutes and shared by different topics", async t => {
  const first = harness();
  const second = harness();
  const sessions = [first, second].map(h => sessionFor(h.bot, getTopic(h.threadId)!));
  t.after(() => { endSession(first.threadId); endSession(second.threadId); first.agent.close(); second.agent.close(); });
  assert.equal(getCapacityRetryMinutes(), 3);
  const waiting = sessions.map(session => session.capacity.recover(capacity, 0, true));
  await until(() => first.messages.length === 1 && second.messages.length === 1);
  setCapacityRetryMinutes(0);
  await capacityRetrySettingsChanged();
  assert.deepEqual(await Promise.all(waiting), [false, false]);
  assert.equal(getCapacityRetryMinutes(), 0);
  for (const value of [-1, 61, 0.5, NaN, Infinity]) assert.throws(() => setCapacityRetryMinutes(value));
  setCapacityRetryMinutes(60);
  assert.equal(getCapacityRetryMinutes(), 60);
});

test("global retry minutes survive a process restart and apply to newly created topics", () => {
  const root = mkdtempSync(join(tmpdir(), "tg-retry-settings-"));
  const dbUrl = new URL("../src/storage/db.ts", import.meta.url).href;
  const run = (script: string) => spawnSync(process.execPath, [
    "--import", import.meta.resolve("tsx"), "--input-type=module", "--eval", script,
  ], { env: { ...process.env, DB_PATH: join(root, "state.db") }, encoding: "utf8", timeout: 30_000 });
  try {
    const saved = run(`const { setCapacityRetryMinutes } = await import(${JSON.stringify(dbUrl)});
      setCapacityRetryMinutes(17);`);
    assert.equal(saved.status, 0, saved.stderr);
    const restored = run(`import assert from "node:assert/strict";
      const { getCapacityRetryMinutes, createTopic } = await import(${JSON.stringify(dbUrl)});
      assert.equal(getCapacityRetryMinutes(), 17);
      createTopic({ threadId: 1, cwd: "/tmp", title: "New Codex topic", provider: "codex" });
      assert.equal(getCapacityRetryMinutes(), 17);`);
    assert.equal(restored.status, 0, restored.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("recovery model pickers require confirmation and cancel on timeout without changing ordinary pickers", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const h = harness();
  let handler: any;
  const bot = { api: h.bot.api, on(_filter: string, fn: any) { handler = fn; } } as any;
  registerPickerButtons(bot);
  const group = { key: "m", options: [{ value: "model-a", label: "A" }, { value: "model-b", label: "B" }],
    perRow: 2, initial: "model-a", fallback: "model-a", summary: (v: string | null) => `Model: ${v}` };
  const press = async (data: string) => handler({ from: { id: cfg.allowedUserId }, callbackQuery: { data }, api: bot.api,
    async answerCallbackQuery() {} }, () => assert.fail("picker must own callback"));
  for (const requireConfirm of [true, false]) {
    const picker = askPick(bot, { threadId: h.threadId, title: "Model", groups: [group], requireConfirm });
    await tick();
    const data = h.messages.at(-1)!.options.reply_markup.inline_keyboard[0][1].callback_data;
    await press(data);
    t.mock.timers.tick(PICK_WAIT_MS);
    assert.equal((await picker).cancelled, requireConfirm);
  }
  const picker = askPick(bot, { threadId: h.threadId, title: "Model", groups: [group], requireConfirm: true });
  await tick();
  const kb = h.messages.at(-1)!.options.reply_markup.inline_keyboard;
  await press(kb[0][1].callback_data);
  await press(kb[1][0].callback_data);
  const selected = await picker;
  assert.equal(selected.cancelled, false);
  assert.equal(selected.picks.m, "model-b");
  h.agent.close();
});
