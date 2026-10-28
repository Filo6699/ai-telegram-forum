import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeAgentSession } from "../src/providers/claude/session.ts";
import { CodexAgentSession } from "../src/providers/codex/session.ts";
import { CodexAppServerClient, type AppServerNotification } from "../src/providers/codex/app-server-client.ts";
import type { AgentSessionOptions, AgentTurnResult, CompactionResult } from "../src/sessions/types.ts";

const tick = () => new Promise<void>(setImmediate);
async function until(condition: () => boolean) {
  for (let n = 0; n < 100; n++) { if (condition()) return; await tick(); }
  assert.fail("condition was not reached");
}

function harness() {
  const prompts: any[] = [];
  const messages: any[] = [];
  const events: string[] = [];
  const compactions: CompactionResult[] = [];
  const turns: AgentTurnResult[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  const startQuery = ({ prompt }: any) => {
    void (async () => { for await (const message of prompt) prompts.push(message.message.content); })();
    return {
      async *[Symbol.asyncIterator]() {
        while (!ended) {
          if (!messages.length) await new Promise<void>(resolve => { wake = resolve; });
          while (messages.length) yield messages.shift();
        }
      },
      close() { ended = true; wake?.(); },
    };
  };
  const opts: AgentSessionOptions = {
    bot: {} as any, threadId: 1, cwd: "/tmp", provider: "claude", sessionId: "s", model: null, effort: null,
    serviceTier: null, openrouter: null,
    channel: { sent: 0, resetSent() {} } as any,
    hooks: {
      async beginTurn() { events.push("begin"); }, session() {}, text() {}, tool() {},
      async endTurn(result) { turns.push(result); },
      compacting() { events.push("compacting"); },
      compacted(result) { compactions.push(result); },
    },
  };
  const agent = new ClaudeAgentSession(opts, startQuery as any);
  const emit = (msg: any) => { messages.push(msg); wake?.(); wake = null; };
  const result = () => emit({ type: "result", subtype: "success", is_error: false, result: "", session_id: "s", usage: {} });
  return { agent, emit, result, prompts, events, compactions, turns, end() { ended = true; wake?.(); } };
}

test("Claude /compact reports sizes from the compact boundary", async t => {
  const h = harness();
  t.after(() => { h.agent.close(); h.end(); });
  assert.equal(await h.agent.compact("keep the API notes"), true);
  await until(() => h.prompts.length === 1);
  assert.equal(h.prompts[0], "/compact keep the API notes");
  assert.equal(await h.agent.compact(""), false, "a second compaction waits for the first");

  h.emit({ type: "system", subtype: "status", status: "compacting", session_id: "s" });
  h.emit({ type: "system", subtype: "status", status: null, compact_result: "success", session_id: "s" });
  h.emit({ type: "system", subtype: "compact_boundary", session_id: "s",
    compact_metadata: { trigger: "manual", pre_tokens: 14867, post_tokens: 3458 } });
  h.result();
  await until(() => h.turns.length === 1);
  assert.deepEqual(h.events, ["begin", "compacting"]);
  assert.deepEqual(h.compactions, [{ ok: true, preTokens: 14867, postTokens: 3458 }]);
  assert.equal(h.turns[0]!.ok, true);
});

test("Claude /compact with nothing to compact fails with the CLI's message", async t => {
  const h = harness();
  t.after(() => { h.agent.close(); h.end(); });
  await h.agent.compact("");
  h.emit({ type: "assistant", parent_tool_use_id: null,
    message: { model: "<synthetic>", content: [{ type: "text", text: "Error: No messages to compact" }] } });
  h.result();
  await until(() => h.turns.length === 1);
  assert.equal(h.turns[0]!.ok, false);
  assert.equal(h.turns[0]!.failure, "⚠️ Error: No messages to compact");
  assert.deepEqual(h.compactions, []);
});

class FakeCodexServer extends CodexAppServerClient {
  calls: string[] = [];
  listeners = new Set<(n: AppServerNotification) => void>();
  override async request<T>(method: string): Promise<T> {
    this.calls.push(method);
    if (method === "thread/resume") return { thread: { id: "native" } } as T;
    if (method === "turn/start") return { turn: { id: "t1" } } as T;
    return {} as T;
  }
  override onNotification(listener: (n: AppServerNotification) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  override onRequest() { return () => {}; }
  emit(method: string, params: any) {
    for (const listener of [...this.listeners]) listener({ method, params: { threadId: "native", ...params } });
  }
  usage(turnId: string, totalTokens: number) {
    this.emit("thread/tokenUsage/updated", { turnId, tokenUsage: {
      total: { totalTokens, inputTokens: totalTokens, cachedInputTokens: 0, outputTokens: 0 },
      last: { totalTokens, inputTokens: totalTokens, cachedInputTokens: 0, outputTokens: 0 },
    } });
  }
  override close() { this.listeners.clear(); }
}

test("Codex /compact runs thread/compact/start and reports the context before and after", async t => {
  const server = new FakeCodexServer();
  const compactions: CompactionResult[] = [];
  const turns: AgentTurnResult[] = [];
  const agent = new CodexAgentSession({
    bot: { api: {} } as any, threadId: 2, cwd: "/tmp", provider: "codex", sessionId: "native", model: null, effort: null,
    serviceTier: null, openrouter: null, channel: {} as any,
    hooks: { async beginTurn() {}, session() {}, text() {}, tool() {},
      async endTurn(result) { turns.push(result); },
      compacting() {}, compacted(result) { compactions.push(result); } },
  }, server);
  t.after(() => agent.close());

  await agent.send({ text: "hi", images: [] });
  await until(() => server.calls.includes("turn/start"));
  server.usage("t1", 12426);
  server.emit("turn/completed", { turn: { id: "t1", status: "completed" } });
  await until(() => turns.length === 1);

  assert.equal(await agent.compact(), true);
  await until(() => server.calls.includes("thread/compact/start"));
  assert.equal(await agent.compact(), false, "a second compaction waits for the first");
  server.emit("turn/started", { turn: { id: "c1" } });
  server.emit("item/started", { turnId: "c1", item: { type: "contextCompaction", id: "x" } });
  server.usage("c1", 6636);
  server.emit("item/completed", { turnId: "c1", item: { type: "contextCompaction", id: "x" } });
  server.emit("turn/completed", { turn: { id: "c1", status: "completed" } });
  await until(() => turns.length === 2);

  assert.deepEqual(compactions, [{ ok: true, preTokens: 12426, postTokens: 6636 }]);
  assert.equal(turns[1]!.ok, true);
});
