import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeAgentSession } from "../src/providers/claude/session.ts";
import type { AgentSessionOptions } from "../src/sessions/types.ts";

const tick = () => new Promise<void>(setImmediate);
async function until(condition: () => boolean) {
  for (let n = 0; n < 100; n++) { if (condition()) return; await tick(); }
  assert.fail("condition was not reached");
}

function harness() {
  const messages: any[] = [];
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
    hooks: { async beginTurn() {}, session() {}, text() {}, tool() {}, async endTurn() {} },
  };
  const agent = new ClaudeAgentSession(opts, startQuery as any);
  const emit = (msg: any) => { messages.push(msg); wake?.(); wake = null; };
  const tasks = (...list: any[]) => emit({ type: "system", subtype: "background_tasks_changed", tasks: list });
  return { agent, emit, tasks, get kills() { return kills; }, end() { ended = true; wake?.(); } };
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
