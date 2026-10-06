import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const configUrl = new URL("../src/config/env.ts", import.meta.url).href;
const sweepUrl = new URL("../src/app/sweep.ts", import.meta.url).href;
const dbUrl = new URL("../src/storage/db.ts", import.meta.url).href;
const settingsUrl = new URL("../src/config/settings.ts", import.meta.url).href;
const runtimeUrl = new URL("../src/config/runtime.ts", import.meta.url).href;

function run(hours: string | undefined, script: string) {
  const cwd = mkdtempSync(join(tmpdir(), "tg-sweep-"));
  try {
    writeFileSync(join(cwd, "config.json"), JSON.stringify(hours === undefined
      ? {} : { DELETE_AFTER_HOURS: Number.isFinite(Number(hours)) ? Number(hours) : hours }));
    const setup = `
      const { loadSettings } = await import(${JSON.stringify(settingsUrl)});
      const { buildConfig } = await import(${JSON.stringify(runtimeUrl)});
      const settings = loadSettings("./config.json");
      const configModule = await import(${JSON.stringify(configUrl)});
      Object.assign(configModule.cfg, buildConfig(settings, process.env));
    `;
    return spawnSync(process.execPath, [
      "--import", import.meta.resolve("tsx"), "--input-type=module", "--eval", setup + script,
    ], {
      cwd,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        BOT_TOKEN: "test-token",
        FORUM_CHAT_ID: "-100123",
        ALLOWED_USER_ID: "123",
        DB_PATH: ":memory:",
      },
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

for (const hours of ["0", undefined, "1.5"]) {
  test(`topic sweep with DELETE_AFTER_HOURS=${hours ?? "default"}`, () => {
    const expectedMs = Number(hours ?? 168) * 3600_000;
    const result = run(hours, `
      import assert from "node:assert/strict";
      const { cfg } = await import(${JSON.stringify(configUrl)});
      const { createTopic, getTopic } = await import(${JSON.stringify(dbUrl)});
      const { startSweep } = await import(${JSON.stringify(sweepUrl)});
      assert.equal(cfg.deleteAfterMs, ${expectedMs});
      const now = Date.now();
      Date.now = () => now - 8 * 24 * 3600_000;
      createTopic({ threadId: 1, cwd: process.cwd(), title: "stale" });
      Date.now = () => now;
      createTopic({ threadId: 2, cwd: process.cwd(), title: "recent" });
      const deleted = [];
      const timers = [];
      globalThis.setInterval = (callback, ms) => { timers.push({ callback, ms }); };
      startSweep({ api: { deleteForumTopic: async (chatId, threadId) => {
        assert.equal(chatId, cfg.chatId);
        deleted.push(threadId);
      } } });
      await new Promise(setImmediate);
      if (cfg.deleteAfterMs === 0) {
        assert.deepEqual(deleted, []);
        assert.equal(timers.length, 0);
        assert.ok(getTopic(1));
        assert.ok(getTopic(2));
      } else {
        assert.deepEqual(deleted, [1]);
        assert.equal(getTopic(1), undefined);
        assert.ok(getTopic(2));
        assert.equal(timers.length, 1);
        assert.equal(timers[0].ms, 5 * 60_000);
        Date.now = () => now + 8 * 24 * 3600_000;
        timers[0].callback();
        await new Promise(setImmediate);
        assert.deepEqual(deleted, [1, 2]);
        assert.equal(getTopic(2), undefined);
      }
    `);
    assert.equal(result.status, 0, result.stderr || String(result.error));
  });
}

for (const hours of ["-1", "invalid", "Infinity"]) {
  test(`invalid DELETE_AFTER_HOURS=${hours} is rejected`, () => {
    const result = run(hours, `await import(${JSON.stringify(configUrl)});`);
    assert.equal(result.status, 1, result.stderr || String(result.error));
    assert.match(result.stderr, /Invalid config.json: DELETE_AFTER_HOURS/);
  });
}
