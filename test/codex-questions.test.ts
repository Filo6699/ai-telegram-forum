import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServerError, CodexAppServerClient, type AppServerNotification, type AppServerRequest } from "../src/providers/codex/app-server-client.ts";
import { CodexAgentSession } from "../src/providers/codex/session.ts";
import { CodexQuestions } from "../src/providers/codex/questions.ts";
import { TelegramQuestions } from "../src/telegram/questions.ts";
import { replyContext } from "../src/telegram/reply.ts";
import { cfg } from "../src/config/env.ts";
import { getQuestionPrompt, deleteTopic, itemQuestionPrompts } from "../src/storage/db.ts";
import type { AgentSessionOptions, AgentTurnResult } from "../src/sessions/types.ts";
import { TopicSession } from "../src/sessions/topic.ts";
import { TopicRenderer } from "../src/telegram/render.ts";
import { runTgSend, type TgSendResult } from "../src/telegram/tg-tools.ts";

const tick = () => new Promise<void>(setImmediate);
async function until(condition: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await tick();
  }
  assert.fail("condition was not reached");
}

class FakeServer extends CodexAppServerClient {
  calls: { method: string; params: any }[] = [];
  notices = new Set<(n: AppServerNotification) => void>();
  requests = new Set<(r: AppServerRequest) => boolean>();
  steerError: Error | null = null;
  beforeSteerError?: () => void;
  nextTurn = 1;
  override async request<T>(method: string, params?: any): Promise<T> {
    this.calls.push({ method, params });
    if (method === "thread/start" || method === "thread/resume") return { thread: { id: params.threadId ?? "native" } } as T;
    if (method === "turn/start") {
      const id = `turn-${this.nextTurn++}`;
      this.emit("turn/started", { threadId: params.threadId, turn: { id } });
      return { turn: { id } } as T;
    }
    if (method === "turn/steer" && this.steerError) {
      this.beforeSteerError?.();
      throw this.steerError;
    }
    if (method === "turn/interrupt") this.complete(params.threadId, params.turnId, "interrupted");
    return {} as T;
  }
  override onNotification(listener: (n: AppServerNotification) => void) {
    this.notices.add(listener);
    return () => { this.notices.delete(listener); };
  }
  override onRequest(listener: (r: AppServerRequest) => boolean) {
    this.requests.add(listener);
    return () => { this.requests.delete(listener); };
  }
  emit(method: string, params: any) {
    for (const listener of [...this.notices]) listener({ method, params });
  }
  complete(threadId: string, turnId = "turn-1", status = "completed") {
    this.emit("turn/completed", { threadId, turn: { id: turnId, status } });
  }
  override close() {
    this.emit("client/closed", { error: new Error("closed") });
    this.notices.clear();
    this.requests.clear();
  }
}

let nextTopic = 5000;
function harness() {
  const threadId = nextTopic++;
  const sessionId = `native-${threadId}`;
  let nextMessage = 1;
  const messages: { id: number; text: string; options: any }[] = [];
  const edits: { id: number; text: string }[] = [];
  const api = {
    async sendMessage(_chat: number, text: string, options: any) {
      const id = nextMessage++;
      messages.push({ id, text, options });
      return { message_id: id };
    },
    async editMessageText(_chat: number, id: number, text: string) {
      edits.push({ id, text });
      return true;
    },
  };
  const texts: string[] = [];
  const results: AgentTurnResult[] = [];
  const opts: AgentSessionOptions = {
    bot: { api } as any, threadId, cwd: "/tmp", provider: "codex", sessionId,
    effort: null, model: null, serviceTier: null, openrouter: null,
    channel: { send: async () => ({ content: [{ type: "text", text: "sent" }] }) } as any,
    hooks: {
      async beginTurn() {}, session() {}, tool() {}, text: (t) => { texts.push(t); },
      async endTurn(result) { results.push(result); },
    },
  };
  const server = new FakeServer();
  const session = new CodexAgentSession(opts, server);
  const prompts = new TelegramQuestions(api as any, cfg.chatId, threadId);
  const prompt = (id: number) => getQuestionPrompt(cfg.chatId, threadId, id)!;
  const emitQuestion = (itemId = "async", questions = [{ title: "Which database?", options: ["SQLite", "Postgres"] }]) => {
    server.emit("item/completed", {
      threadId: sessionId, turnId: "turn-1",
      item: { type: "agentMessage", id: itemId, phase: "final_answer", delivery: "async", text: "question", questions },
    });
  };
  return { threadId, sessionId, messages, edits, api, opts, texts, results, server, session, prompts, prompt, emitQuestion };
}

for (const delivered of [false, true]) {
  test(`attachment failures reach the active Codex turn (text delivered: ${delivered})`, async (t) => {
    const h = harness();
    t.after(() => h.session.close());
    let sends = 0;
    h.opts.channel.send = async (args) => {
      sends++;
      return runTgSend(new TopicRenderer(h.api as any, cfg.chatId, h.threadId), h.opts.cwd, args);
    };
    await h.session.send({ text: "work", images: [] });
    await until(() => h.server.calls.some((c) => c.method === "turn/start"));
    const item = {
      id: "send-image", type: "mcpToolCall", server: "tg", tool: "send", status: "completed",
      arguments: { text: delivered ? "Here is the image" : "", files: ["missing-feedback-image.png"] },
    };
    h.server.emit("item/completed", { threadId: "child-thread", turnId: "child-turn", item });
    await tick();
    assert.equal(sends, 0);
    h.server.emit("item/completed", { threadId: h.sessionId, turnId: "turn-1", item });
    await until(() => h.server.calls.some((c) => c.method === "turn/steer"));
    const steer = h.server.calls.find((c) => c.method === "turn/steer")!.params;
    assert.equal(steer.threadId, h.sessionId);
    assert.equal(steer.expectedTurnId, "turn-1");
    assert.match(steer.input[0].text, /send-image[\s\S]*missing-feedback-image.png[\s\S]*Tell the user immediately[\s\S]*Do not split/);
    assert.equal(sends, 1);
    h.server.complete(h.sessionId);
    await until(() => h.results.length === 1);
    assert.equal(h.results[0]!.sent, delivered ? 1 : 0);
    assert.equal(h.server.calls.filter((c) => c.method === "turn/start").length, 1);
  });
}

test("attachment failure after turn completion starts a follow-up with the delivery feedback", async (t) => {
  const h = harness();
  t.after(() => h.session.close());
  let release!: (result: TgSendResult) => void;
  h.opts.channel.send = () => new Promise((resolve) => { release = resolve; });
  await h.session.send({ text: "work", images: [] });
  await until(() => h.server.calls.some((c) => c.method === "turn/start"));
  const args = { files: ["missing-feedback-image.png"] };
  h.server.emit("item/completed", {
    threadId: h.sessionId, turnId: "turn-1",
    item: { id: "send-image", type: "mcpToolCall", server: "tg", tool: "send", status: "completed", arguments: args },
  });
  h.server.complete(h.sessionId);
  release(await runTgSend(new TopicRenderer(h.api as any, cfg.chatId, h.threadId), h.opts.cwd, args));
  await until(() => h.server.calls.filter((c) => c.method === "turn/start").length === 2);
  const start = h.server.calls.filter((c) => c.method === "turn/start")[1]!.params;
  assert.match(start.input[0].text, /attachment delivery feedback[\s\S]*missing-feedback-image.png[\s\S]*Do not split/);
  assert.equal(h.server.calls.some((c) => c.method === "turn/steer"), false);
  h.server.complete(h.sessionId, "turn-2");
  await until(() => h.results.length === 2);
});

test("successful sends and failed text-only sends do not create attachment feedback turns", async (t) => {
  const h = harness();
  t.after(() => h.session.close());
  h.opts.channel.send = async (args) => args.files?.length
    ? { content: [{ type: "text", text: "sent (1 file(s), id: 1)" }] }
    : { content: [{ type: "text", text: "delivery failed" }], isError: true, _meta: { delivered: false } };
  await h.session.send({ text: "work", images: [] });
  await until(() => h.server.calls.some((c) => c.method === "turn/start"));
  for (const args of [{ files: ["image.png"] }, { text: "Explanation" }]) {
    h.server.emit("item/completed", {
      threadId: h.sessionId, turnId: "turn-1",
      item: { id: "send", type: "mcpToolCall", server: "tg", tool: "send", status: "completed", arguments: args },
    });
  }
  h.server.complete(h.sessionId);
  await until(() => h.results.length === 1);
  assert.equal(h.results[0]!.sent, 1);
  assert.equal(h.server.calls.some((c) => c.method === "turn/steer"), false);
  assert.equal(h.server.calls.filter((c) => c.method === "turn/start").length, 1);
});

test("async questions appear mid-turn, accept replies out of order and never become the final answer", async (t) => {
  const h = harness();
  t.after(() => h.session.close());
  await h.session.send({ text: "work", images: [] });
  await until(() => h.server.calls.some((c) => c.method === "turn/start"));
  h.emitQuestion("async", [{ title: "Database?", options: ["SQLite", "Postgres"] }, { title: "Audience?" }]);
  await until(() => h.messages.length === 2);
  assert.deepEqual(h.texts, []);
  assert.equal(h.results.length, 0);
  assert.match(h.messages[0]!.text, /1\. SQLite/);
  assert.equal(h.messages[0]!.options.message_thread_id, h.threadId);
  assert.equal(await h.session.answerQuestion(2, { text: "Developers", images: [] }), true);
  assert.equal(await h.session.answerQuestion(1, { text: "SQLite", images: [] }), true);
  const steers = h.server.calls.filter((c) => c.method === "turn/steer");
  assert.equal(steers.length, 2);
  assert.match(steers[0]!.params.input[0].text, /Audience\?[\s\S]*Developers/);
  assert.equal(steers[0]!.params.expectedTurnId, "turn-1");
  assert.equal(h.server.calls.filter((c) => c.method === "turn/start").length, 1);
  assert.equal(h.prompt(1).state, "answered");
  h.server.emit("item/completed", { threadId: h.sessionId, turnId: "turn-1", item: { type: "agentMessage", phase: "final_answer", text: "Done" } });
  h.server.complete(h.sessionId);
  await until(() => h.results.length === 1);
  assert.deepEqual(h.texts, ["Done"]);
  // Question delivery must not suppress the final-text fallback.
  assert.equal(h.results[0]!.sent, 0);
});

test("an unanswered async question survives turn completion and a new live session", async (t) => {
  const h = harness();
  await h.session.send({ text: "work", images: [] });
  await until(() => h.server.calls.some((c) => c.method === "turn/start"));
  h.emitQuestion();
  await until(() => h.messages.length === 1);
  h.server.complete(h.sessionId);
  await until(() => h.results.length === 1);
  h.session.close();
  const server = new FakeServer();
  const resumed = new CodexAgentSession(h.opts, server);
  t.after(() => resumed.close());
  assert.equal(await resumed.answerQuestion(1, { text: "Postgres", images: [] }), true);
  await until(() => server.calls.some((c) => c.method === "turn/start"));
  const start = server.calls.find((c) => c.method === "turn/start")!;
  assert.match(start.params.input[0].text, /Which database\?[\s\S]*Postgres/);
  assert.equal(server.calls.some((c) => c.method === "turn/steer"), false);
  server.complete(h.sessionId);
  await until(() => h.results.length === 2);
});

test("RPC answers are returned once on the original request after every question is answered", async (t) => {
  const h = harness();
  t.after(() => h.session.close());
  await h.session.send({ text: "work", images: [] });
  await until(() => h.server.requests.size > 0);
  const responses: any[] = [];
  const request: AppServerRequest = {
    id: "server-request-1", method: "item/tool/requestUserInput",
    params: { threadId: h.sessionId, turnId: "turn-1", itemId: "rpc", isBlocking: true, questions: [
      { id: "database", question: "Database?", options: [{ label: "SQLite", description: "Local" }] },
      { id: "audience", question: "Audience?" },
    ] },
    async respond(result) { responses.push(result); },
  };
  assert.equal([...h.server.requests][0]!(request), true);
  await until(() => h.messages.length === 2);
  await h.session.answerQuestion(2, { text: "Developers", images: [] });
  assert.equal(responses.length, 0);
  await h.session.answerQuestion(1, { text: "SQLite", images: [] });
  assert.equal(responses.length, 1);
  assert.deepEqual({ ...responses[0].answers }, {
    audience: { answers: ["Developers"] }, database: { answers: ["SQLite"] },
  });
  assert.equal(h.server.calls.some((c) => c.method === "turn/steer"), false);
  assert.equal(await h.session.answerQuestion(1, { text: "Clarification", images: [] }), false);
  assert.equal(responses.length, 1);
  h.server.complete(h.sessionId);
  await until(() => h.results.length === 1);
});

test("a turn completion racing with steer queues the answer exactly once", async (t) => {
  const h = harness();
  t.after(() => h.session.close());
  await h.session.send({ text: "work", images: [] });
  await until(() => h.server.calls.some((c) => c.method === "turn/start"));
  h.emitQuestion();
  await until(() => h.messages.length === 1);
  h.server.steerError = new AppServerError("No active turn", -32600);
  h.server.beforeSteerError = () => h.server.complete(h.sessionId);
  await h.session.answerQuestion(1, { text: "SQLite", images: [] });
  await until(() => h.server.calls.filter((c) => c.method === "turn/start").length === 2);
  assert.equal(h.server.calls.filter((c) => c.method === "turn/steer").length, 1);
  assert.equal(h.prompt(1).state, "answered");
  h.server.complete(h.sessionId, "turn-2");
  await until(() => h.results.length === 2);
});

test("transport failure leaves an async answer retryable instead of silently duplicating it", async (t) => {
  const h = harness();
  t.after(() => h.session.close());
  await h.session.send({ text: "work", images: [] });
  await until(() => h.server.calls.some((c) => c.method === "turn/start"));
  h.emitQuestion();
  await until(() => h.messages.length === 1);
  h.server.steerError = new Error("connection lost");
  await h.session.answerQuestion(1, { text: "SQLite", images: [] });
  assert.equal(h.prompt(1).state, "open");
  assert.match(h.messages.at(-1)!.text, /reply again to retry/);
  assert.equal(h.server.calls.filter((c) => c.method === "turn/start").length, 1);
  h.server.steerError = null;
  await h.session.answerQuestion(1, { text: "SQLite", images: [] });
  assert.equal(h.prompt(1).state, "answered");
  h.server.complete(h.sessionId);
  await until(() => h.results.length === 1);
});

test("RPC timeout sends no assumed answer, and a late reply becomes contextual input", async () => {
  const h = harness();
  const delivered: any[] = [];
  const responses: any[] = [];
  const questions = new CodexQuestions(h.prompts, 20, async (input) => { delivered.push(input); });
  questions.request({ id: 8, method: "item/tool/requestUserInput", params: {
    threadId: h.sessionId, turnId: "turn-1", itemId: "rpc-timeout", questions: [{ id: "q", question: "Pick one" }],
  }, async respond(result) { responses.push(result); } });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(responses.length, 1);
  assert.deepEqual(Object.keys(responses[0].answers), []);
  assert.equal(h.prompt(1).state, "closed");
  await questions.answer(1, h.sessionId, { text: "Custom", images: [] });
  assert.match(delivered[0].text, /Pick one[\s\S]*Custom/);
  assert.equal(responses.length, 1);
  questions.close();
});

test("RPC timeout preserves actual partial answers and never submits an unanswered option", async () => {
  const h = harness();
  const responses: any[] = [];
  const questions = new CodexQuestions(h.prompts, 20, async () => {});
  questions.request({ id: "partial", method: "item/tool/requestUserInput", params: {
    threadId: h.sessionId, turnId: "turn-1", itemId: "rpc-partial", questions: [
      { id: "first", question: "First?" }, { id: "second", question: "Second?", options: [{ label: "Default" }] },
    ],
  }, async respond(result) { responses.push(result); } });
  await until(() => h.messages.length === 2);
  await questions.answer(1, h.sessionId, { text: "Actual answer", images: [] });
  // A correction to an answered question updates the still-pending request.
  await questions.answer(1, h.sessionId, { text: "Corrected answer", images: [] });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(responses.length, 1);
  assert.deepEqual({ ...responses[0].answers }, { first: { answers: ["Corrected answer"] } });
  assert.equal(h.prompt(2).state, "closed");
  questions.close();
});

test("server resolution closes its prompt without replying to a dead request", async () => {
  const h = harness();
  const responses: any[] = [];
  const questions = new CodexQuestions(h.prompts, 1000, async () => {});
  questions.request({ id: "resolved", method: "item/tool/requestUserInput", params: {
    threadId: h.sessionId, turnId: "turn-1", itemId: "rpc-resolved", questions: [{ id: "q", question: "Question?" }],
  }, async respond(result) { responses.push(result); } });
  await until(() => h.messages.length === 1);
  questions.resolved("resolved");
  await tick();
  assert.equal(responses.length, 0);
  assert.equal(h.prompt(1).state, "closed");
  questions.close();
});

test("stop closes structured questions and preserves the session", async (t) => {
  const h = harness();
  t.after(() => h.session.close());
  await h.session.send({ text: "work", images: [] });
  await until(() => h.server.requests.size > 0);
  const responses: any[] = [];
  [...h.server.requests][0]!({ id: 1, method: "item/tool/requestUserInput", params: {
    threadId: h.sessionId, turnId: "turn-1", itemId: "rpc-stop", questions: [{ id: "q", question: "Question?" }],
  }, async respond(result) { responses.push(result); } });
  await until(() => h.messages.length === 1);
  assert.equal(await h.session.interrupt(), true);
  await until(() => h.results.length === 1);
  assert.equal(h.results[0]!.stopped, true);
  assert.equal(responses.length, 1);
  assert.equal(h.prompt(1).state, "closed");
});

test("cancellation during Telegram delivery settles the RPC and closes the arriving prompt", async () => {
  const h = harness();
  let release!: () => void;
  const send = h.api.sendMessage;
  h.api.sendMessage = async (...args) => {
    await new Promise<void>((resolve) => { release = resolve; });
    return send(...args);
  };
  const questions = new CodexQuestions(h.prompts, 1000, async () => {});
  const responses: any[] = [];
  questions.request({ id: "cancel", method: "item/tool/requestUserInput", params: {
    threadId: h.sessionId, turnId: "turn-1", itemId: "rpc-cancel", questions: [{ id: "q", question: "Question?" }],
  }, async respond(result) { responses.push(result); } });
  questions.cancelTurn(h.sessionId, "turn-1");
  release();
  await until(() => h.edits.length === 1);
  assert.equal(responses.length, 1);
  assert.equal(h.prompt(1).state, "closed");
  questions.close();
});

test("failed question delivery settles the RPC without crashing or waiting for timeout", async () => {
  const h = harness();
  h.api.sendMessage = async () => { throw new Error("Telegram offline"); };
  const questions = new CodexQuestions(h.prompts, 1000, async () => {});
  const responses: any[] = [];
  questions.request({ id: 9, method: "item/tool/requestUserInput", params: {
    threadId: h.sessionId, turnId: "turn-1", itemId: "rpc-fail", questions: [{ id: "q", question: "Question?" }],
  }, async respond(result) { responses.push(result); } });
  await until(() => responses.length === 1);
  assert.deepEqual(Object.keys(responses[0].answers), []);
  questions.close();
});

test("long prompt chunks share their answer binding and disappear with the topic", async () => {
  const h = harness();
  await h.prompts.ask({ sessionId: h.sessionId, turnId: "turn-1", itemId: "long", kind: "async" },
    [{ id: "q", text: "Question? ".repeat(1000) }]);
  assert.ok(h.messages.length > 1);
  assert.ok(h.messages.every((m) => m.text.length <= 4096));
  const otherTopic = new TelegramQuestions(h.api as any, cfg.chatId, h.threadId + 100);
  assert.equal(otherTopic.find(1), undefined);
  const delivered: any[] = [];
  const questions = new CodexQuestions(h.prompts, 1000, async (input) => { delivered.push(input); });
  assert.equal(await questions.answer(1, "another-session", { text: "answer", images: [] }), false);
  await questions.answer(1, h.sessionId, { text: "answer", images: [] });
  assert.equal(delivered.length, 1);
  assert.ok(itemQuestionPrompts(cfg.chatId, h.threadId, h.sessionId, "turn-1", "long").every((p) => p.state === "answered"));
  deleteTopic(h.threadId);
  assert.equal(h.prompts.find(1), undefined);
  questions.close();
});

test("ordinary replies quote the selected message and preserve multiline text", () => {
  assert.equal(replyContext({ text: "Plain", images: [] }), "Plain");
  assert.match(replyContext({ text: "Answer", images: [], replyTo: { messageId: 42, text: "First\nSecond" } }),
    /message 42:\n> First\n> Second\n\nUser reply:\nAnswer/);
});

test("topic routing consumes native answers before adding progress instructions, and quotes other replies", async (t) => {
  const h = harness();
  const topic = new TopicSession(h.opts.bot, h.threadId, "/tmp", h.sessionId, "codex");
  let claimed = true;
  const answered: any[] = [];
  const sent: any[] = [];
  (topic as any).agent = {
    async answerQuestion(id: number, input: any) { answered.push({ id, input }); return claimed; },
    async send(input: any) { sent.push(input); },
    close() {},
  };
  t.after(() => topic.close());
  const input = { text: "Custom answer", images: [], replyTo: { messageId: 15, text: "Question?" } };
  await topic.send(input);
  assert.equal(answered[0].id, 15);
  assert.equal(answered[0].input.text, "Custom answer");
  assert.equal(sent.length, 0);
  claimed = false;
  await topic.send(input);
  assert.match(sent[0].text, /communication preference[\s\S]*> Question\?[\s\S]*Custom answer/);
});

test("question bindings persist across processes independently of the live RPC connection", () => {
  const root = mkdtempSync(join(tmpdir(), "tg-question-state-"));
  const dbUrl = new URL("../src/storage/db.ts", import.meta.url).href;
  const run = (script: string) => spawnSync(process.execPath, [
    "--import", import.meta.resolve("tsx"), "--input-type=module", "--eval", script,
  ], { env: { ...process.env, DB_PATH: join(root, "state.db") }, encoding: "utf8", timeout: 30_000 });
  try {
    const saved = run(`const { saveQuestionPrompt } = await import(${JSON.stringify(dbUrl)});
      saveQuestionPrompt({ chat_id: -1, thread_id: 7, message_id: 42, session_id: "native",
        turn_id: "turn", item_id: "async", question_id: "0", kind: "async",
        question: "Audience?", display_text: "Audience?", state: "open" });`);
    assert.equal(saved.status, 0, saved.stderr);
    const restored = run(`import assert from "node:assert/strict";
      const { getQuestionPrompt } = await import(${JSON.stringify(dbUrl)});
      assert.equal(getQuestionPrompt(-1, 7, 42).question, "Audience?");
      assert.equal(getQuestionPrompt(-1, 7, 42).state, "open");`);
    assert.equal(restored.status, 0, restored.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("JSON-RPC input requests support string IDs, settle once, and respect server cleanup", async () => {
  const client = new CodexAppServerClient();
  const wires: any[] = [];
  const child = { stdin: { write(line: string, callback?: (err?: Error) => void) {
    wires.push(JSON.parse(line)); callback?.();
  } }, kill() {} };
  (client as any).child = child;
  let request!: AppServerRequest;
  client.onRequest((r) => { request = r; return r.method === "item/tool/requestUserInput"; });
  (client as any).receive(JSON.stringify({ id: "server-1", method: "item/tool/requestUserInput", params: {} }));
  assert.equal(wires.length, 0);
  await request.respond({ answers: { q: { answers: ["yes"] } } });
  assert.deepEqual(wires[0], { id: "server-1", result: { answers: { q: { answers: ["yes"] } } } });
  await assert.rejects(request.respond({ answers: {} }), /no longer open/);
  (client as any).receive(JSON.stringify({ id: 2, method: "item/tool/requestUserInput", params: {} }));
  (client as any).receive(JSON.stringify({ method: "serverRequest/resolved", params: { requestId: 2 } }));
  await assert.rejects(request.respond({ answers: {} }), /no longer open/);
  (client as any).receive(JSON.stringify({ id: 3, method: "item/commandExecution/requestApproval", params: {} }));
  assert.equal(wires[1].error.code, -32601);
  client.close();
});
