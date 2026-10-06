import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseEnv } from "dotenv";
import test from "node:test";
import { loadSettings, parseSettings } from "../src/config/settings.ts";
import { buildConfig } from "../src/config/runtime.ts";
import { LOCAL_ENV_KEYS, splitLegacyEnv } from "../src/config/migrate.ts";

const local = { BOT_TOKEN: "test:token", FORUM_CHAT_ID: "-100123", ALLOWED_USER_ID: "123" };

test("portable settings come from config.json even when old env settings are present", () => {
  const cfg = buildConfig(parseSettings({
    PROVIDER: "codex", DEFAULT_CWD: "/projects/app", PROJECTS: { app: "./projects/app" },
    CODEX_EFFORT: "high", PERMISSION: "auto", ALLOWED_TOOLS: ["Read"],
    DELETE_AFTER_HOURS: 2, SESSION_IDLE_MINUTES: 3, PERMISSION_TIMEOUT_MINUTES: 4,
    LAUNCHER_THREAD_ID: 42, OPENROUTER_MAX_STEPS: 7,
  }), { ...local, PROVIDER: "claude", DEFAULT_CWD: "/wrong", CODEX_EFFORT: "low",
    PERMISSION: "bypass", DB_PATH: "/local/state.db", PID_PATH: "/local/bot.pid" });
  assert.equal(cfg.provider, "codex");
  assert.equal(cfg.defaultCwd, "/projects/app");
  assert.equal(cfg.codexEffort, "high");
  assert.equal(cfg.permission, "auto");
  assert.deepEqual(cfg.allowedTools, ["Read"]);
  assert.equal(cfg.launcherThreadId, 42);
  assert.equal(cfg.deleteAfterMs, 2 * 3600_000);
  assert.equal(cfg.sessionIdleMs, 3 * 60_000);
  assert.equal(cfg.permissionTimeoutMs, 4 * 60_000);
  assert.equal(cfg.openrouterMaxSteps, 7);
  assert.equal(cfg.dbPath, "/local/state.db");
  assert.equal(cfg.pidPath, "/local/bot.pid");
});

test("config rejects credentials, unknown keys and invalid setting types", () => {
  for (const raw of [
    { BOT_TOKEN: "secret" }, { DB_PATH: "/state.db" }, { PROVIDER: "invalid" },
    { PERMISSION: "oops" }, { PROJECTS: { app: 1 } }, { ALLOWED_TOOLS: "Read,Bash" },
    { OPENROUTER_MAX_STEPS: -1 }, { SESSION_IDLE_MINUTES: "20" },
  ]) assert.throws(() => parseSettings(raw), /Invalid config.json/);
});

test("missing config uses defaults; malformed files report their location", () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-config-"));
  const path = join(dir, "config.json");
  try {
    assert.equal(loadSettings(path).DEFAULT_CWD, ".");
    writeFileSync(path, '{"PROVIDER":');
    assert.throws(() => loadSettings(path), /Invalid JSON in config.json/);
    writeFileSync(path, '{"PROVIDER":"codex"}');
    assert.equal(loadSettings(path).PROVIDER, "codex");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("zero still disables topic deletion; negative and overflowing durations fail", () => {
  assert.equal(buildConfig(parseSettings({ DELETE_AFTER_HOURS: 0 }), local).deleteAfterMs, 0);
  for (const hours of [-1, Infinity, Number.MAX_VALUE]) {
    assert.throws(() => parseSettings({ DELETE_AFTER_HOURS: hours }), /DELETE_AFTER_HOURS/);
  }
});

test("OpenRouter still requires the API key in env and parses JSON preset objects", () => {
  const settings = parseSettings({ PROVIDER: "openrouter", OPENROUTER_PRESETS: {
    Free: { model: "openrouter/free", max_tokens: 4096 },
  } });
  assert.throws(() => buildConfig(settings, local), /requires a non-empty OPENROUTER_API_KEY/);
  const cfg = buildConfig(settings, { ...local, OPENROUTER_API_KEY: " test-key " });
  assert.equal(cfg.openrouterApiKey, "test-key");
  assert.equal(cfg.openrouterPresets[0]?.maxTokens, 4096);
  assert.throws(() => buildConfig(parseSettings({ CODEX_DEFAULT_PRESET: "missing" }), local), /requires at least one/);
});

test("migration preserves the six local values and converts multiline settings to native JSON", () => {
  const source = `BOT_TOKEN="test:token#with-hash"
FORUM_CHAT_ID=-100123
ALLOWED_USER_ID=123
OPENROUTER_API_KEY='test-key'
DB_PATH='C:\\local\\state.db'
PID_PATH=./bot.pid
PROJECTS='{
  "app": "/projects/app"
}'
MODEL=claude-custom
CLAUDE_MODEL=claude-current
LAUNCHER_THREAD_ID=general
DEFAULT_CWD=/projects/app
PROVIDER=codex
CODEX_EFFORT=high
CODEX_PRESETS='{
  "Quick": {"model":"gpt-5.6-sol","effort":"light","fast":true}
}'
CODEX_DEFAULT_PRESET=Quick
ALLOWED_TOOLS=Read, Bash
DELETE_AFTER_HOURS=12
`;
  const result = splitLegacyEnv(source);
  const env = parseEnv(result.envText);
  assert.deepEqual(Object.keys(env), [...LOCAL_ENV_KEYS]);
  const original = parseEnv(source);
  for (const key of LOCAL_ENV_KEYS) assert.equal(env[key], original[key]);
  assert.deepEqual(result.settings.PROJECTS, { app: "/projects/app" });
  assert.deepEqual(result.settings.ALLOWED_TOOLS, ["Read", "Bash"]);
  assert.equal(result.settings.CLAUDE_MODEL, "claude-current");
  assert.equal(result.settings.DELETE_AFTER_HOURS, 12);
  assert.equal(result.settings.LAUNCHER_THREAD_ID, "General");
  const cfg = buildConfig(result.settings, env);
  assert.equal(cfg.codexDefaultPreset, "Quick");
  assert.equal(cfg.codexPresets[0]?.effort, "low");
  assert.equal(cfg.codexPresets[0]?.serviceTier, "fast");
  assert.ok(!JSON.stringify(result.settings).includes("test-key"));
});

test("migration rejects unknown variables and invalid presets before any writes", () => {
  const source = Object.entries(local).map(([key, value]) => `${key}=${value}`).join("\n");
  assert.throws(() => splitLegacyEnv(`${source}\nCUSTOM_SECRET=test`), /unknown env var CUSTOM_SECRET/);
  assert.throws(() => splitLegacyEnv(`${source}\nPROJECTS=oops`), /PROJECTS: invalid JSON/);
  assert.throws(() => splitLegacyEnv(`${source}\nCODEX_PRESETS={"Bad":{"model":"x","effort":"oops"}}`), /not a valid model/);
  const result = splitLegacyEnv(source);
  assert.deepEqual(Object.keys(parseEnv(result.envText)), [...LOCAL_ENV_KEYS]);
});
