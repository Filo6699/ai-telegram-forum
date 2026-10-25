import type { Usage } from "../sessions/usage.ts";
import { DatabaseSync } from "node:sqlite";
import { progressLevels, type Progress, type Toolcalls } from "../telegram/activity.ts";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { cfg } from "../config/env.ts";
import type { Effort } from "../config/effort.ts";
import type { Model } from "../config/model.ts";
import type { ServiceTier } from "../config/service-tier.ts";
import type { Provider } from "../config/provider.ts";
import type { OpenRouterSettings } from "../config/openrouter-settings.ts";
import type { ModelSettings } from "../config/presets.ts";
import { DEFAULT_CAPACITY_RETRY_MINUTES } from "../sessions/capacity-retry.ts";

export type TopicStatus = "active" | "closed";

export interface Topic {
  progress: Progress;
  toolcalls: Toolcalls;
  thread_id: number;
  session_id: string | null;
  /** Terminal session whose persistent native fork was created by telegramify. */
  source_session_id: string | null;
  /** Existing rows predate providers and are migrated as Claude topics. */
  provider: Provider;
  cwd: string;
  title: string;
  /** null = no choice of ours; the session runs on Claude's own default. */
  effort: Effort;
  /** null = no choice of ours; the session runs on the configured `MODEL`. */
  model: Model;
  /** Codex throughput mode; null lets an adopted/existing session inherit its config. */
  service_tier: ServiceTier;
  /** Full OpenRouter preset/model settings; absent for other providers. */
  openrouter_settings: OpenRouterSettings | null;
  status: TopicStatus;
  last_activity: number;
  created_at: number;
  turns: number;
  in_tokens: number;
  out_tokens: number;
  cost_usd: number;
  cost_known: number;
}

mkdirSync(dirname(cfg.dbPath), { recursive: true });

const db = new DatabaseSync(cfg.dbPath);
db.exec(`
  CREATE TABLE IF NOT EXISTS topics (
    thread_id     INTEGER PRIMARY KEY,
    session_id    TEXT,
    source_session_id TEXT,
    provider      TEXT NOT NULL DEFAULT 'claude',
    cwd           TEXT NOT NULL,
    title         TEXT NOT NULL,
    effort        TEXT,
    model         TEXT,
    service_tier  TEXT,
    openrouter_settings TEXT,
    status        TEXT NOT NULL DEFAULT 'active',
    last_activity INTEGER NOT NULL,
    created_at    INTEGER NOT NULL,
    turns         INTEGER NOT NULL DEFAULT 0,
    in_tokens     INTEGER NOT NULL DEFAULT 0,
    out_tokens    INTEGER NOT NULL DEFAULT 0,
    cost_usd      REAL    NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS codex_turn_tiers (
    session_id TEXT NOT NULL,
    turn_id    TEXT NOT NULL,
    service_tier TEXT NOT NULL CHECK (service_tier IN ('default', 'fast')),
    PRIMARY KEY (session_id, turn_id)
  );
  CREATE TABLE IF NOT EXISTS question_prompts (
    chat_id INTEGER NOT NULL,
    thread_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    question_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('async', 'rpc')),
    question TEXT NOT NULL,
    display_text TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'open',
    PRIMARY KEY (chat_id, thread_id, message_id)
  );
  CREATE TABLE IF NOT EXISTS claude_weekly_samples (
    at          INTEGER NOT NULL,
    resets_at   INTEGER NOT NULL,
    utilization REAL    NOT NULL,
    local_usd   REAL    NOT NULL,
    plan        TEXT
  );
  CREATE INDEX IF NOT EXISTS claude_weekly_samples_at ON claude_weekly_samples (at);
  CREATE INDEX IF NOT EXISTS question_prompts_item
    ON question_prompts (chat_id, thread_id, session_id, turn_id, item_id);
`);

// Migrate older DBs that predate the usage columns.
for (const col of [
  "progress TEXT NOT NULL DEFAULT 'off'",
  "toolcalls TEXT NOT NULL DEFAULT 'off'",
  "turns INTEGER NOT NULL DEFAULT 0",
  "in_tokens INTEGER NOT NULL DEFAULT 0",
  "out_tokens INTEGER NOT NULL DEFAULT 0",
  "cost_usd REAL NOT NULL DEFAULT 0",
  "cost_known INTEGER NOT NULL DEFAULT 1",
  "effort TEXT",
  "model TEXT",
  "service_tier TEXT",
  "openrouter_settings TEXT",
  "provider TEXT NOT NULL DEFAULT 'claude'",
  "source_session_id TEXT",
]) {
  try {
    db.exec(`ALTER TABLE topics ADD COLUMN ${col}`);
  } catch {
    // column already exists — ignore
  }
}

db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS topics_source_session
  ON topics (provider, source_session_id) WHERE source_session_id IS NOT NULL`);

const stmts = {
  getSetting: db.prepare("SELECT value FROM settings WHERE key = ?"),
  setSetting: db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ),
  get: db.prepare("SELECT * FROM topics WHERE thread_id = ?"),
  bySession: db.prepare("SELECT * FROM topics WHERE provider = ? AND session_id = ?"),
  bySourceSession: db.prepare("SELECT * FROM topics WHERE provider = ? AND source_session_id = ?"),
  insert: db.prepare(
    `INSERT INTO topics (thread_id, session_id, source_session_id, provider, cwd, title, effort, model, service_tier, openrouter_settings, status, last_activity, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
  ),
  setEffort: db.prepare("UPDATE topics SET effort = ? WHERE thread_id = ?"),
  setModel: db.prepare("UPDATE topics SET model = ? WHERE thread_id = ?"),
  setModelSettings: db.prepare(
    "UPDATE topics SET model = ?, effort = ?, service_tier = ?, openrouter_settings = ? WHERE thread_id = ?",
  ),
  setOpenRouterSettings: db.prepare(
    "UPDATE topics SET model = ?, effort = NULL, service_tier = NULL, openrouter_settings = ? WHERE thread_id = ?",
  ),
  setSession: db.prepare(
    "UPDATE topics SET session_id = ?, last_activity = ? WHERE thread_id = ?",
  ),
  touch: db.prepare(
    "UPDATE topics SET last_activity = ?, status = 'active' WHERE thread_id = ?",
  ),
  setStatus: db.prepare("UPDATE topics SET status = ? WHERE thread_id = ?"),
  setTitle: db.prepare("UPDATE topics SET title = ? WHERE thread_id = ?"),
  del: db.prepare("DELETE FROM topics WHERE thread_id = ?"),
  stale: db.prepare("SELECT * FROM topics WHERE last_activity < ?"),
  addUsage: db.prepare(
    `UPDATE topics
       SET turns = turns + 1,
           in_tokens = in_tokens + ?,
           out_tokens = out_tokens + ?,
           cost_usd = cost_usd + COALESCE(?, 0),
           cost_known = CASE WHEN ? IS NULL THEN 0 ELSE cost_known END
     WHERE thread_id = ?`,
  ),
  totals: db.prepare(
    `SELECT COUNT(*) AS topics,
            COALESCE(SUM(turns), 0) AS turns,
            COALESCE(SUM(in_tokens), 0) AS in_tokens,
            COALESCE(SUM(out_tokens), 0) AS out_tokens,
            COALESCE(SUM(cost_usd), 0) AS cost_usd
            , MIN(cost_known) AS cost_known
       FROM topics`,
  ),
  setCodexTurnTier: db.prepare(
    `INSERT INTO codex_turn_tiers (session_id, turn_id, service_tier)
     VALUES (?, ?, ?)
     ON CONFLICT(session_id, turn_id) DO UPDATE SET service_tier = excluded.service_tier`,
  ),
  backfillCodexTurnTier: db.prepare(
    "INSERT OR IGNORE INTO codex_turn_tiers (session_id, turn_id, service_tier) VALUES (?, ?, ?)",
  ),
  codexTurnTiers: db.prepare(
    "SELECT turn_id, service_tier FROM codex_turn_tiers WHERE session_id = ?",
  ),
};

export function getTopic(threadId: number): Topic | undefined {
  const raw = stmts.get.get(threadId) as any;
  return raw ? decodeTopic(raw) : undefined;
}

/** The topic already bound to this provider's session id, if any. */
export function findBySession(sessionId: string, provider: Provider = "claude"): Topic | undefined {
  return stmts.bySession.get(provider, sessionId) as unknown as Topic | undefined;
}

/** Repeated Codex handoffs reuse the topic created from this terminal session. */
export function findBySourceSession(sessionId: string, provider: Provider): Topic | undefined {
  const raw = stmts.bySourceSession.get(provider, sessionId);
  return raw ? decodeTopic(raw) : undefined;
}

export function createTopic(t: {
  threadId: number;
  cwd: string;
  title: string;
  provider?: Provider;
  effort?: Effort;
  model?: Model;
  serviceTier?: ServiceTier;
  openrouterSettings?: OpenRouterSettings | null;
  /** Set when adopting a session that already exists on disk (`/telegramify`). */
  sessionId?: string | null;
  sourceSessionId?: string | null;
}): void {
  const now = Date.now();
  stmts.insert.run(
    t.threadId,
    t.sessionId ?? null,
    t.sourceSessionId ?? null,
    t.provider ?? "claude",
    t.cwd,
    t.title,
    t.effort ?? null,
    t.model ?? null,
    t.serviceTier ?? null,
    t.openrouterSettings ? JSON.stringify(t.openrouterSettings) : null,
    now,
    now,
  );
}

export function setEffort(threadId: number, effort: Effort): void {
  stmts.setEffort.run(effort, threadId);
}

export function getCapacityRetryMinutes(): number {
  const row = stmts.getSetting.get("capacity_retry_minutes") as { value: string } | undefined;
  const minutes = row ? Number(row.value) : DEFAULT_CAPACITY_RETRY_MINUTES;
  return Number.isSafeInteger(minutes) && minutes >= 0 && minutes <= 60 ? minutes : DEFAULT_CAPACITY_RETRY_MINUTES;
}

export function setCapacityRetryMinutes(minutes: number): void {
  if (!Number.isSafeInteger(minutes) || minutes < 0 || minutes > 60) {
    throw new Error("Capacity retry duration must be an integer between 0 and 60 minutes");
  }
  stmts.setSetting.run("capacity_retry_minutes", String(minutes));
}

export function setActivity(threadId: number, setting: "progress" | "toolcalls", value: Progress | Toolcalls): void {
  const statement = setting === "progress"
    ? "UPDATE topics SET progress = ? WHERE thread_id = ?"
    : "UPDATE topics SET toolcalls = ? WHERE thread_id = ?";
  db.prepare(statement).run(value, threadId);
}

export function getDefaultProgress(): Progress {
  const row = stmts.getSetting.get("default_progress") as { value?: unknown } | undefined;
  return typeof row?.value === "string" && (progressLevels as readonly string[]).includes(row.value)
    ? row.value as Progress
    : "off";
}

export function setDefaultProgress(value: Progress): void {
  stmts.setSetting.run("default_progress", value);
}

export function setModel(threadId: number, model: Model): void {
  stmts.setModel.run(model, threadId);
}

/** Apply a complete set of settings, such as a preset, as one persisted change. */
export function setModelSettings(threadId: number, settings: ModelSettings): void {
  stmts.setModelSettings.run(
    settings.model,
    settings.effort,
    settings.serviceTier,
    settings.openrouter ? JSON.stringify(settings.openrouter) : null,
    threadId,
  );
}

/** Remember the tier used for each turn; recent Codex rollouts omit it. */
export function recordCodexTurnTier(
  sessionId: string,
  turnId: string,
  serviceTier: Exclude<ServiceTier, null>,
): void {
  stmts.setCodexTurnTier.run(sessionId, turnId, serviceTier);
}

export function backfillCodexTurnTier(
  sessionId: string,
  turnId: string,
  serviceTier: Exclude<ServiceTier, null>,
): void {
  stmts.backfillCodexTurnTier.run(sessionId, turnId, serviceTier);
}

export function codexTurnTiers(sessionId: string): Map<string, ServiceTier> {
  const rows = stmts.codexTurnTiers.all(sessionId) as { turn_id: string; service_tier: ServiceTier }[];
  return new Map(rows.map((row) => [row.turn_id, row.service_tier]));
}

export function setOpenRouterSettings(
  threadId: number,
  settings: OpenRouterSettings | null,
): void {
  stmts.setOpenRouterSettings.run(settings?.model ?? null, settings ? JSON.stringify(settings) : null, threadId);
}

export function setSession(threadId: number, sessionId: string): void {
  stmts.setSession.run(sessionId, Date.now(), threadId);
}

export function touch(threadId: number): void {
  stmts.touch.run(Date.now(), threadId);
}

export function setStatus(threadId: number, status: TopicStatus): void {
  stmts.setStatus.run(status, threadId);
}

export function setTitle(threadId: number, title: string): void {
  stmts.setTitle.run(title, threadId);
}

export function deleteTopic(threadId: number): void {
  db.prepare("DELETE FROM question_prompts WHERE thread_id = ?").run(threadId);
  stmts.del.run(threadId);
}

/** Telegram bindings only; native provider transcripts remain untouched. */
export interface QuestionPrompt {
  chat_id: number;
  thread_id: number;
  message_id: number;
  session_id: string;
  turn_id: string;
  item_id: string;
  question_id: string;
  kind: "async" | "rpc";
  question: string;
  display_text: string;
  state: "open" | "answered" | "closed";
}

export function saveQuestionPrompt(p: QuestionPrompt): void {
  db.prepare(`INSERT INTO question_prompts
    (chat_id, thread_id, message_id, session_id, turn_id, item_id, question_id, kind, question, display_text, state)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    p.chat_id, p.thread_id, p.message_id, p.session_id, p.turn_id,
    p.item_id, p.question_id, p.kind, p.question, p.display_text, p.state,
  );
}

export function getQuestionPrompt(chatId: number, threadId: number, messageId: number): QuestionPrompt | undefined {
  return db.prepare("SELECT * FROM question_prompts WHERE chat_id = ? AND thread_id = ? AND message_id = ?")
    .get(chatId, threadId, messageId) as QuestionPrompt | undefined;
}

export function itemQuestionPrompts(chatId: number, threadId: number, sessionId: string, turnId: string, itemId: string): QuestionPrompt[] {
  return db.prepare(`SELECT * FROM question_prompts
    WHERE chat_id = ? AND thread_id = ? AND session_id = ? AND turn_id = ? AND item_id = ?`)
    .all(chatId, threadId, sessionId, turnId, itemId) as unknown as QuestionPrompt[];
}

export function setQuestionPromptState(p: QuestionPrompt, state: QuestionPrompt["state"]): void {
  db.prepare(`UPDATE question_prompts SET state = ?
    WHERE chat_id = ? AND thread_id = ? AND session_id = ? AND turn_id = ? AND item_id = ? AND question_id = ?`)
    .run(state, p.chat_id, p.thread_id, p.session_id, p.turn_id, p.item_id, p.question_id);
}

export interface ClaudeWeeklySample {
  at: number;
  resets_at: number;
  /** Anthropic's account-wide weekly percent, as reported (whole numbers). */
  utilization: number;
  /** API-equivalent USD in local transcripts from the window start to `at`. */
  local_usd: number;
  plan: string | null;
}

export function addClaudeWeeklySample(s: ClaudeWeeklySample): void {
  db.prepare(
    "INSERT INTO claude_weekly_samples (at, resets_at, utilization, local_usd, plan) VALUES (?, ?, ?, ?, ?)",
  ).run(s.at, s.resets_at, s.utilization, s.local_usd, s.plan);
}

export function claudeWeeklySamples(since: number): ClaudeWeeklySample[] {
  return db.prepare("SELECT * FROM claude_weekly_samples WHERE at >= ? ORDER BY at")
    .all(since) as unknown as ClaudeWeeklySample[];
}

export function getSetting(key: string): string | null {
  const row = stmts.getSetting.get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  stmts.setSetting.run(key, value);
}

export function addUsage(threadId: number, u: Usage): void {
  stmts.addUsage.run(u.inTokens, u.outTokens, u.costUsd, u.costUsd, threadId);
}

export interface Totals {
  topics: number;
  turns: number;
  in_tokens: number;
  out_tokens: number;
  cost_usd: number;
  cost_known: number;
}

export function totals(): Totals {
  return stmts.totals.get() as unknown as Totals;
}

/** Roots whose native rollouts can repair older Codex token tallies on read. */
export function codexUsageTopics(): Topic[] {
  return (db.prepare("SELECT * FROM topics WHERE provider = 'codex' AND session_id IS NOT NULL")
    .all() as any[]).map(decodeTopic);
}

/** Topics idle past `deleteAfterMs`, whatever their status. */
export function listStale(deleteAfterMs: number): Topic[] {
  return (stmts.stale.all(Date.now() - deleteAfterMs) as any[]).map(decodeTopic);
}

function decodeTopic(raw: any): Topic {
  let openrouterSettings: OpenRouterSettings | null = null;
  if (typeof raw.openrouter_settings === "string") {
    try {
      openrouterSettings = JSON.parse(raw.openrouter_settings) as OpenRouterSettings;
    } catch {
      console.warn(`[db] ignoring invalid OpenRouter settings for topic ${raw.thread_id}`);
    }
  }
  return { ...raw, openrouter_settings: openrouterSettings } as Topic;
}
