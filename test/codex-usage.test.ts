import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexAgentSession } from "../src/providers/codex/session.ts";
import { parseCodexRollout } from "../src/providers/codex/session-usage.ts";
import { codexRolloutIndex } from "../src/providers/codex/rollout-index.ts";
import { estimateCodexWeeklyPercent } from "../src/providers/codex/quota.ts";

const response = { input_tokens: 16_431, cached_input_tokens: 12_160, output_tokens: 89, total_tokens: 16_520 };
const context = { type: "turn_context", payload: { model: "gpt-6.1-sol", service_tier: null } };
const tokenEvent = (total: typeof response) => ({
  type: "event_msg",
  payload: { type: "token_count", info: { last_token_usage: response, total_token_usage: total } },
});
const jsonl = (records: unknown[]) => records.map(record => JSON.stringify(record)).join("\n");

test("real Codex rate-limit-only repeats do not charge a response again", () => {
  const parsed = parseCodexRollout(jsonl([context, tokenEvent(response), tokenEvent(response)]));
  assert.equal(parsed.usage?.totalTokens, 16_520);
  assert.equal(parsed.usage?.inputTokens, 16_431);
  assert.equal(parsed.usage?.outputTokens, 89);
  const credits = ((16_431 - 12_160) * 50 + 12_160 * 2.5 + 89 * 250) / 1_000_000;
  assert.equal(parsed.usage?.estimatedWeeklyPercent, estimateCodexWeeklyPercent(credits));
});

test("equally sized real responses count separately, including after a cumulative reset", () => {
  const twice = Object.fromEntries(Object.entries(response).map(([key, value]) => [key, value * 2])) as typeof response;
  const parsed = parseCodexRollout(jsonl([
    context, tokenEvent(response), tokenEvent(twice), tokenEvent(twice), tokenEvent(response),
  ]));
  assert.equal(parsed.usage?.totalTokens, response.total_tokens * 3);
});

test("a child rollout charges only usage after its own session header", () => {
  const parsed = parseCodexRollout(jsonl([
    { type: "session_meta", timestamp: "2026-10-06T12:00:00Z", payload: { id: "child" } },
    { ...context, timestamp: "2026-10-06T11:00:00Z" },
    { ...tokenEvent(response), timestamp: "2026-10-06T11:00:01Z" },
    { ...context, timestamp: "2026-10-06T12:00:01Z" },
    { ...tokenEvent(response), timestamp: "2026-10-06T12:00:02Z" },
  ]));
  assert.equal(parsed.usage?.totalTokens, response.total_tokens);
});

test("native headers discover spawned children in active and archived logs, excluding manual forks", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-usage-index-"));
  try {
    const active = join(home, "sessions", "2026", "10", "06");
    const archived = join(home, "archived_sessions");
    await mkdir(active, { recursive: true });
    await mkdir(archived);
    const parent = join(active, "rollout-parent.jsonl");
    await writeFile(parent, jsonl([{ type: "session_meta", payload: { id: "parent", source: "vscode" } }]));
    for (const [id, directory, source] of [
      ["child", active, { subagent: { thread_spawn: { parent_thread_id: "parent" } } }],
      ["archived-child", archived, { subagent: { thread_spawn: { parent_thread_id: "child" } } }],
      ["manual-fork", active, "vscode"],
    ] as const) {
      await writeFile(join(directory, `rollout-${id}.jsonl`), jsonl([
        { type: "session_meta", payload: { id, forked_from_id: "parent", source } },
        // Inherited headers must not replace the child's own identity.
        { type: "session_meta", payload: { id: "parent", source: "vscode" } },
      ]));
    }
    const index = await codexRolloutIndex(parent);
    assert.deepEqual([...index!.children.get("parent")!], ["child"]);
    assert.deepEqual([...index!.children.get("child")!], ["archived-child"]);
    assert.equal(index!.paths.get("parent"), parent);
    await writeFile(join(active, "rollout-new-child.jsonl"), jsonl([
      { type: "session_meta", payload: { id: "new-child", source: {
        subagent: { thread_spawn: { parent_thread_id: "parent" } },
      } } },
    ]));
    const refreshed = await codexRolloutIndex(parent);
    assert.deepEqual([...refreshed!.children.get("parent")!].sort(), ["child", "new-child"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("app-server turns aggregate all responses and isolate other threads and turns", async () => {
  const session = new CodexAgentSession({ model: "gpt-6.1-sol" } as any) as any;
  let notify: (event: any) => void;
  session.server = {
    onNotification(listener: typeof notify) { notify = listener; return () => {}; },
    async request() {
      const last = { inputTokens: 100, cachedInputTokens: 80, outputTokens: 10, totalTokens: 110 };
      notify({ method: "turn/started", params: { threadId: "parent", turn: { id: "turn" } } });
      const usage = (threadId: string, turnId: string, multiple: number) => notify({
        method: "thread/tokenUsage/updated", params: {
          threadId, turnId, tokenUsage: {
            last, total: { inputTokens: multiple * 100, cachedInputTokens: multiple * 80, outputTokens: multiple * 10, totalTokens: multiple * 110 },
          },
        },
      });
      // Cumulative counters include earlier turns, which must not be billed here.
      usage("parent", "turn", 101);
      usage("child", "turn", 102);
      usage("parent", "old-turn", 102);
      usage("parent", "turn", 102);
      usage("parent", "turn", 102);
      notify({ method: "turn/completed", params: { threadId: "parent", turn: { id: "turn", status: "completed" } } });
      return { turn: { id: "turn" } };
    },
  };
  const result = await session.runAppTurn("parent", { text: "task", images: [] }, { onTool() {}, deliverTelegram: false });
  assert.deepEqual(result.usage, { inTokens: 200, outTokens: 20, costUsd: null });
});
