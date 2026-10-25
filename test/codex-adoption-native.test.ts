import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repo = fileURLToPath(new URL("..", import.meta.url));
const evalScript = (script: string, env: NodeJS.ProcessEnv) => execFileSync(process.execPath, [
  "--import", import.meta.resolve("tsx"), "--input-type=module", "--eval", script,
], { cwd: repo, env, encoding: "utf8", timeout: 45_000 });

test("native Codex forks a writer-locked source and immediately resumes the persisted fork", () => {
  // Entirely synthetic Codex home, no account credentials and no model turns.
  const home = mkdtempSync(join(tmpdir(), "tg-native-fork-"));
  try {
    const cwd = join(home, "project");
    mkdirSync(cwd);
    writeFileSync(join(home, "config.toml"), `model = "fixture-model"
model_provider = "fixture"
[model_providers.fixture]
name = "Fixture"
base_url = "http://127.0.0.1:9/v1"
wire_api = "responses"
requires_openai_auth = false
`);
    const sourceId = "01999aaa-1111-7111-8111-111111111111";
    const timestamp = "2026-10-20T00:00:00.000Z";
    const directory = join(home, "sessions", "2026", "10", "20");
    mkdirSync(directory, { recursive: true });
    const sourcePath = join(directory, `rollout-2026-10-20T00-00-00-${sourceId}.jsonl`);
    const records = [
      { type: "session_meta", payload: {
        id: sourceId, timestamp, cwd, originator: "codex_cli_rs", cli_version: "0.159.0",
        source: "cli", model_provider: "fixture", base_instructions: { text: "Fixture only." },
      } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-1", model_context_window: 128_000, collaboration_mode_kind: "default" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Remember native fork fixture token" }] } },
      { type: "event_msg", payload: { type: "user_message", message: "Remember native fork fixture token", images: [], local_images: [] } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Saved fixture reply" }], phase: "final_answer" } },
      { type: "event_msg", payload: { type: "agent_message", message: "Saved fixture reply", phase: "final_answer" } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1", last_agent_message: "Saved fixture reply" } },
    ];
    writeFileSync(sourcePath, records.map(record => JSON.stringify({ timestamp, ...record })).join("\n") + "\n");
    const output = evalScript(`
      import assert from "node:assert/strict";
      import { readFileSync } from "node:fs";
      import { CodexAppServerClient } from "./src/providers/codex/app-server-client.ts";
      import { codexRequest } from "./src/providers/codex/app-server.ts";
      const parent = new CodexAppServerClient();
      const child = new CodexAppServerClient();
      const sourceId = ${JSON.stringify(sourceId)};
      try {
        await parent.request("thread/resume", { threadId: sourceId, excludeTurns: true });
        await assert.rejects(codexRequest("thread/resume", { threadId: sourceId, excludeTurns: true }), /active writer/);
        const before = readFileSync(${JSON.stringify(sourcePath)}, "utf8");
        const fork = await codexRequest("thread/fork", { threadId: sourceId, cwd: ${JSON.stringify(cwd)}, ephemeral: false, excludeTurns: true });
        assert.notEqual(fork.thread.id, sourceId);
        const stored = await codexRequest("thread/read", { threadId: fork.thread.id, includeTurns: true });
        assert.match(JSON.stringify(stored.thread.turns), /Remember native fork fixture token/);
        assert.match(JSON.stringify(stored.thread.turns), /Saved fixture reply/);
        const resumed = await child.request("thread/resume", { threadId: fork.thread.id, excludeTurns: true });
        assert.equal(resumed.thread.id, fork.thread.id);
        assert.equal(readFileSync(${JSON.stringify(sourcePath)}, "utf8"), before);
        // The original is still owned by its original server, not the fork's.
        await assert.rejects(codexRequest("thread/resume", { threadId: sourceId, excludeTurns: true }), /active writer/);
        console.log("fork persisted, history preserved, source untouched, both sessions independently loaded");
      } finally {
        parent.close();
        child.close();
      }
    `, { ...process.env, CODEX_HOME: home, CODEX_EXEC_SERVER_URL: "" });
    assert.match(output, /both sessions independently loaded/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("legacy DB migration and a new CLI process preserve source-to-fork idempotency", () => {
  const home = mkdtempSync(join(tmpdir(), "tg-fork-state-"));
  const env = { ...process.env, DB_PATH: join(home, "state.db") };
  try {
    evalScript(`
      import { DatabaseSync } from "node:sqlite";
      const db = new DatabaseSync(process.env.DB_PATH);
      db.exec("CREATE TABLE topics (thread_id INTEGER PRIMARY KEY, session_id TEXT, cwd TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', last_activity INTEGER NOT NULL, created_at INTEGER NOT NULL)");
      db.exec("INSERT INTO topics VALUES (1, 'legacy-session', '/tmp', 'Legacy Claude topic', 'active', 0, 0)");
      db.close();
    `, env);
    const script = (first: boolean) => `
      import assert from "node:assert/strict";
      import { adoptCodex } from "./src/cli/codexify.ts";
      import { getTopic, findBySourceSession } from "./src/storage/db.ts";
      assert.equal(getTopic(1).provider, "claude");
      assert.equal(getTopic(1).source_session_id, null);
      const first = ${first};
      let forkCalls = 0;
      await adoptCodex(["--session", "source-fixture"], {
        brokerPid: () => process.pid,
        async request(method, params) {
          if (method === "thread/read") return { thread: { id: params.threadId, cwd: "/tmp", preview: "Fixture", turns: [] } };
          assert.ok(first);
          assert.equal(method, "thread/fork");
          forkCalls++;
          return { thread: { id: "fork-fixture" } };
        },
        api: {
          async createForumTopic() { assert.ok(first); return { message_thread_id: 2 }; },
          async sendMessage() { assert.ok(first); return { message_id: 3 }; },
        },
      });
      assert.equal(forkCalls, first ? 1 : 0);
      assert.equal(findBySourceSession("source-fixture", "codex").session_id, "fork-fixture");
      assert.equal(findBySourceSession("source-fixture", "claude"), undefined);
    `;
    assert.match(evalScript(script(true), env), /Created a persistent Codex fork/);
    assert.match(evalScript(script(false), env), /Already in Telegram \(fork\)/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
