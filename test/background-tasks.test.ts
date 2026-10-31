import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeAgentSession } from "../src/providers/claude/session.ts";
import { TopicSession } from "../src/sessions/topic.ts";
import { createTopic } from "../src/storage/db.ts";
import type { AgentSessionOptions, AgentTurnResult } from "../src/sessions/types.ts";

const tick = () => new Promise<void>(setImmediate);
async function until(condition: () => boolean) {
  for (let n = 0; n < 100; n++) { if (condition()) return; await tick(); }
  assert.fail("condition was not reached");
}

function harness() {
  const messages: any[] = [];
  const results: any[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  let kills = 0;
  const startQuery = ({ prompt }: any) => {
    void (async () => { for await (const _ of prompt); })();
    return {
      async *[Symbol.asyncIterator]() {
        while (!ended) {
          if (!messages.length) await new Promise<void>(resolve => { wake = resolve; });
          while (messages.length) yield messages.shift();
        }
      },
      close() { kills++; ended = true; wake?.(); },
    };
  };
  const opts: AgentSessionOptions = {
    bot: {} as any, threadId: 1, cwd: "/tmp", provider: "claude", sessionId: null, model: null, effort: null,
    serviceTier: null, openrouter: null,
    channel: { sent: 0, resetSent() {} } as any,
    hooks: { async beginTurn() {}, session() {}, text() {}, tool() {}, async endTurn(r) { results.push(r); } },
  };
  const agent = new ClaudeAgentSession(opts, startQuery as any);
  const emit = (msg: any) => { messages.push(msg); wake?.(); wake = null; };
  const tasks = (...list: any[]) => emit({ type: "system", subtype: "background_tasks_changed", tasks: list });
  const say = (text: string) =>
    emit({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text }] } });
  const done = (text: string) =>
    emit({ type: "result", subtype: "success", is_error: false, result: text, session_id: "s", usage: {}, modelUsage: {} });
  return { agent, emit, tasks, say, done, results, get kills() { return kills; }, end() { ended = true; wake?.(); } };
}

test("Claude counts live background tasks, leaving out ambient watchers", async t => {
  const h = harness();
  t.after(() => { h.agent.close(); h.end(); });
  await h.agent.send({ text: "work", images: [] });
  h.tasks(
    { task_id: "a", task_type: "local_bash", description: "build" },
    { task_id: "b", task_type: "monitor", description: "watch", ambient: true },
  );
  await until(() => h.agent.backgroundTasks === 1);
  h.tasks();
  await until(() => h.agent.backgroundTasks === 0);
});

test("closing a Claude session stops the CLI only while background tasks remain", async t => {
  const busy = harness();
  t.after(() => busy.end());
  await busy.agent.send({ text: "work", images: [] });
  busy.tasks({ task_id: "a", task_type: "local_bash", description: "build" });
  await until(() => busy.agent.backgroundTasks === 1);
  busy.agent.close();
  assert.equal(busy.kills, 1);

  const quiet = harness();
  t.after(() => quiet.end());
  await quiet.agent.send({ text: "work", images: [] });
  await tick();
  quiet.agent.close();
  assert.equal(quiet.kills, 0);
});

test("a turn the CLI starts while tasks still run is marked as awaiting them", async t => {
  const h = harness();
  t.after(() => { h.agent.close(); h.end(); });
  await h.agent.send({ text: "build it", images: [] });
  h.tasks({ task_id: "a", task_type: "local_bash", description: "build" });
  h.say("Waiting for the build.");
  h.done("Waiting for the build.");
  await until(() => h.results.length === 1);
  // The person asked; their turn's text stays owed to them.
  assert.equal(h.results[0].awaitingTasks, false);

  h.say("Still building.");
  h.done("Still building.");
  await until(() => h.results.length === 2);
  assert.equal(h.results[1].awaitingTasks, true);

  h.tasks();
  h.say("Build passed.");
  h.done("Build passed.");
  await until(() => h.results.length === 3);
  assert.equal(h.results[2].awaitingTasks, false);
});

test("a message that joins a CLI-started turn makes its text owed again", async t => {
  const h = harness();
  t.after(() => { h.agent.close(); h.end(); });
  h.tasks({ task_id: "a", task_type: "local_bash", description: "build" });
  h.say("Checking the log.");
  await tick();
  await h.agent.send({ text: "what's the status?", images: [] });
  h.done("Still building, about a minute left.");
  await until(() => h.results.length === 1);
  assert.equal(h.results[0].awaitingTasks, false);
});

test("the topic posts a deferred status only once the background work winds down unanswered", async t => {
  const threadId = 990_001;
  createTopic({ threadId, cwd: "/tmp", title: "Deferred fallback", provider: "claude" });
  const posted: string[] = [];
  const api = { async sendMessage(_chat: number, text: string) { posted.push(text); return { message_id: posted.length }; } };
  const topic = new TopicSession({ api } as any, threadId, "/tmp", null, "claude");
  t.after(() => topic.close());
  const out = (topic as any).out;
  const end = (r: Partial<AgentTurnResult>) => (topic as any).endTurn({
    ok: true, failure: null, stopped: false, sent: 0, usage: { inTokens: 0, outTokens: 0, costUsd: null }, ...r,
  });

  out.hold("Waiting for the build.");
  await end({ awaitingTasks: true });
  assert.deepEqual(posted, []);
  await end({});
  assert.equal(posted.length, 1);
  assert.match(posted[0]!, /Waiting for the build/);

  posted.length = 0;
  out.hold("Waiting for the tests.");
  await end({ awaitingTasks: true });
  await end({ sent: 1 });
  await end({});
  assert.deepEqual(posted, []);
});
