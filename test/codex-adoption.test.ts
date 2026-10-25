import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { adoptCodex } from "../src/cli/codexify.ts";
import { codexAppThreadParams } from "../src/providers/codex/options.ts";
import { createTopic, findBySourceSession, getTopic, setStatus } from "../src/storage/db.ts";

let nextTopic = 70_000;

function harness() {
  const source = {
    id: randomUUID(), cwd: "/tmp", preview: "Continue my project", name: "Project",
    turns: [{ status: "completed", items: [{ type: "agentMessage", phase: "final_answer", text: "Saved answer" }] }],
  };
  const threads = new Map([[source.id, source]]);
  const requests: { method: string; params: any }[] = [];
  const sent: string[] = [];
  const created: number[] = [];
  const reopened: number[] = [];
  const deleted: number[] = [];
  const deps = {
    brokerPid: () => process.pid as number | null,
    async request<T>(method: string, params: any): Promise<T> {
      requests.push({ method, params });
      if (method === "thread/list") return { data: [source] } as T;
      if (method === "thread/read") {
        const thread = threads.get(params.threadId);
        if (!thread) throw new Error("missing thread");
        return { thread } as T;
      }
      if (method === "thread/fork") {
        const fork = { ...source, id: randomUUID() };
        threads.set(fork.id, fork);
        return { thread: { id: fork.id } } as T;
      }
      throw new Error(`unexpected request: ${method}`);
    },
    api: {
      async createForumTopic() {
        const id = nextTopic++;
        created.push(id);
        return { message_thread_id: id, name: "Project", icon_color: 0 };
      },
      async reopenForumTopic(_chat: number, id: number) { reopened.push(id); return true as const; },
      async deleteForumTopic(_chat: number, id: number) { deleted.push(id); return true as const; },
      async sendMessage(_chat: number, text: string) {
        sent.push(text);
        return { message_id: sent.length } as any;
      },
    },
  };
  const run = (extra: string[] = [], id = source.id) => adoptCodex(["--session", id, ...extra], deps);
  const forks = () => requests.filter(call => call.method === "thread/fork");
  return { source, deps, threads, requests, forks, sent, created, reopened, deleted, run };
}

test("Codex telegramify always creates a persistent native fork and identifies it", async (t) => {
  const h = harness();
  const logs: string[] = [];
  t.mock.method(console, "log", (text: string) => logs.push(text));
  await h.run();
  const topic = findBySourceSession(h.source.id, "codex")!;
  assert.notEqual(topic.session_id, h.source.id);
  assert.ok(h.threads.has(topic.session_id!));
  assert.equal(h.forks().length, 1);
  assert.deepEqual(h.forks()[0]!.params, {
    threadId: h.source.id, cwd: "/tmp", ephemeral: false, excludeTurns: true,
  });
  assert.ok(h.requests.every(call => call.method !== "thread/resume"));
  assert.match(h.sent[0]!, /persistent Codex fork/);
  assert.ok(h.sent[0]!.includes(h.source.id));
  assert.ok(h.sent[0]!.includes(topic.session_id!));
  assert.match(h.sent[0]!, /same project files/);
  assert.ok(h.sent.some(text => text.includes("Saved answer")));
  assert.match(logs[0]!, /persistent Codex fork/);
  assert.ok(logs[0]!.includes(`https://t.me/c/123/${topic.thread_id}`));
});

test("repeat calls from the source or fork reuse and reopen the same fork topic", async () => {
  const h = harness();
  await h.run();
  const topic = findBySourceSession(h.source.id, "codex")!;
  setStatus(topic.thread_id, "closed");
  await h.run();
  await h.run([], topic.session_id!);
  assert.equal(h.forks().length, 1);
  assert.equal(h.created.length, 1);
  assert.deepEqual(h.reopened, [topic.thread_id]);
  assert.equal(getTopic(topic.thread_id)!.status, "active");
});

test("an old direct adoption receives a new fork without rebinding its live topic", async () => {
  const h = harness();
  const legacyId = nextTopic++;
  createTopic({ threadId: legacyId, provider: "codex", sessionId: h.source.id, cwd: "/tmp", title: "Legacy" });
  await h.run();
  assert.equal(getTopic(legacyId)!.session_id, h.source.id);
  const fork = findBySourceSession(h.source.id, "codex")!;
  assert.notEqual(fork.thread_id, legacyId);
  assert.notEqual(fork.session_id, h.source.id);
});

test("dry runs never fork, create topics, or reopen a closed topic", async () => {
  const h = harness();
  await h.run(["--dry-run"]);
  assert.equal(h.forks().length, 0);
  assert.equal(h.created.length, 0);
  await h.run();
  const topic = findBySourceSession(h.source.id, "codex")!;
  setStatus(topic.thread_id, "closed");
  await h.run(["--dry-run"]);
  assert.equal(h.forks().length, 1);
  assert.equal(h.created.length, 1);
  assert.equal(h.reopened.length, 0);
  assert.equal(getTopic(topic.thread_id)!.status, "closed");
});

test("an offline broker stops the handoff before any native or Telegram request", async () => {
  const h = harness();
  h.deps.brokerPid = () => null;
  await assert.rejects(h.run(), /broker isn't running/);
  assert.equal(h.requests.length, 0);
  assert.equal(h.created.length, 0);
});

test("failed, invalid, or unpersisted forks never publish a topic", async () => {
  for (const failure of ["error", "same-id", "missing-id", "not-persisted"]) {
    const h = harness();
    const request = h.deps.request;
    h.deps.request = async <T>(method: string, params: any): Promise<T> => {
      if (method !== "thread/fork") return request(method, params);
      if (failure === "error") throw new Error("fork failed");
      return { thread: { id: failure === "same-id" ? h.source.id : failure === "missing-id" ? "" : "missing" } } as T;
    };
    await assert.rejects(h.run());
    assert.equal(h.created.length, 0);
    assert.equal(findBySourceSession(h.source.id, "codex"), undefined);
  }
});

test("a Telegram creation error never binds the source or destroys a native fork", async () => {
  const h = harness();
  h.deps.api.createForumTopic = async () => { throw new Error("Telegram offline"); };
  await assert.rejects(h.run(), /Telegram offline/);
  assert.equal(findBySourceSession(h.source.id, "codex"), undefined);
  assert.equal(h.threads.size, 2);
  assert.equal(h.deleted.length, 0);
});

test("concurrent handoffs keep one binding and remove only the unused Telegram topic", async () => {
  const h = harness();
  await Promise.all([h.run(), h.run()]);
  const topic = findBySourceSession(h.source.id, "codex")!;
  assert.equal(h.created.length, 2);
  assert.equal(h.deleted.length, 1);
  assert.notEqual(h.deleted[0], topic.thread_id);
  assert.equal(getTopic(h.deleted[0]!), undefined);
  assert.equal(h.threads.size, 3); // Both native forks remain intact.
  await h.run();
  assert.equal(h.created.length, 2);
});

test("failed reopen keeps the fork topic closed and retryable", async () => {
  const h = harness();
  await h.run();
  const topic = findBySourceSession(h.source.id, "codex")!;
  setStatus(topic.thread_id, "closed");
  h.deps.api.reopenForumTopic = async () => { throw new Error("Telegram offline"); };
  await assert.rejects(h.run(), /couldn't reopen/);
  assert.equal(getTopic(topic.thread_id)!.status, "closed");
  assert.equal(h.forks().length, 1);
});

test("fork agents announce their origin and do not repeat inherited telegramify instructions", () => {
  const params = codexAppThreadParams({
    threadId: 1, cwd: "/tmp", effort: null, model: null, serviceTier: null, sourceSessionId: "source-id",
  }) as any;
  assert.match(params.developerInstructions, /persistent native Codex fork of terminal session source-id/);
  assert.match(params.developerInstructions, /first reply/);
  assert.match(params.developerInstructions, /Do not repeat it or create another fork/);
  assert.equal(params.config.developer_instructions, params.developerInstructions);
  assert.equal(params.config.mcp_servers.tg.required, true);
});
