import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { cfg } from "./config.ts";
import type { Effort } from "./effort.ts";
import type { Model } from "./model.ts";
import type { ServiceTier } from "./preset-config.ts";
import type { Provider } from "./provider.ts";

export type TopicStatus = "active" | "closed";

export interface Topic {
  thread_id: number;
  session_id: string | null;
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
  status: TopicStatus;
  last_activity: number;
  created_at: number;
  turns: number;
  in_tokens: number;
  out_tokens: number;
  cost_usd: number;
}

export interface Usage {
  inTokens: number;
  outTokens: number;
  costUsd: number;
}

mkdirSync(dirname(cfg.dbPath), { recursive: true });

const db = new DatabaseSync(cfg.dbPath);
db.exec(`
  CREATE TABLE IF NOT EXISTS topics (
    thread_id     INTEGER PRIMARY KEY,
    session_id    TEXT,
    provider      TEXT NOT NULL DEFAULT 'claude',
    cwd           TEXT NOT NULL,
    title         TEXT NOT NULL,
    effort        TEXT,
    model         TEXT,
    service_tier  TEXT,
    status        TEXT NOT NULL DEFAULT 'active',
    last_activity INTEGER NOT NULL,
    created_at    INTEGER NOT NULL,
    turns         INTEGER NOT NULL DEFAULT 0,
    in_tokens     INTEGER NOT NULL DEFAULT 0,
    out_tokens    INTEGER NOT NULL DEFAULT 0,
    cost_usd      REAL    NOT NULL DEFAULT 0
  );
`);

// Migrate older DBs that predate the usage columns.
for (const col of [
  "turns INTEGER NOT NULL DEFAULT 0",
  "in_tokens INTEGER NOT NULL DEFAULT 0",
  "out_tokens INTEGER NOT NULL DEFAULT 0",
  "cost_usd REAL NOT NULL DEFAULT 0",
  "effort TEXT",
  "model TEXT",
  "service_tier TEXT",
  "provider TEXT NOT NULL DEFAULT 'claude'",
]) {
  try {
    db.exec(`ALTER TABLE topics ADD COLUMN ${col}`);
  } catch {
    // column already exists — ignore
  }
}

const stmts = {
  get: db.prepare("SELECT * FROM topics WHERE thread_id = ?"),
  bySession: db.prepare("SELECT * FROM topics WHERE provider = ? AND session_id = ?"),
  insert: db.prepare(
    `INSERT INTO topics (thread_id, session_id, provider, cwd, title, effort, model, service_tier, status, last_activity, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
  ),
  setEffort: db.prepare("UPDATE topics SET effort = ? WHERE thread_id = ?"),
  setModel: db.prepare("UPDATE topics SET model = ? WHERE thread_id = ?"),
  setCodexSettings: db.prepare(
    "UPDATE topics SET model = ?, effort = ?, service_tier = ? WHERE thread_id = ?",
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
           cost_usd = cost_usd + ?
     WHERE thread_id = ?`,
  ),
  totals: db.prepare(
    `SELECT COUNT(*) AS topics,
            COALESCE(SUM(turns), 0) AS turns,
            COALESCE(SUM(in_tokens), 0) AS in_tokens,
            COALESCE(SUM(out_tokens), 0) AS out_tokens,
            COALESCE(SUM(cost_usd), 0) AS cost_usd
       FROM topics`,
  ),
};

export function getTopic(threadId: number): Topic | undefined {
  return stmts.get.get(threadId) as unknown as Topic | undefined;
}

/** The topic already bound to this provider's session id, if any. */
export function findBySession(sessionId: string, provider: Provider = "claude"): Topic | undefined {
  return stmts.bySession.get(provider, sessionId) as unknown as Topic | undefined;
}

export function createTopic(t: {
  threadId: number;
  cwd: string;
  title: string;
  provider?: Provider;
  effort?: Effort;
  model?: Model;
  serviceTier?: ServiceTier;
  /** Set when adopting a session that already exists on disk (`/telegramify`). */
  sessionId?: string | null;
}): void {
  const now = Date.now();
  stmts.insert.run(
    t.threadId,
    t.sessionId ?? null,
    t.provider ?? "claude",
    t.cwd,
    t.title,
    t.effort ?? null,
    t.model ?? null,
    t.serviceTier ?? null,
    now,
    now,
  );
}

export function setEffort(threadId: number, effort: Effort): void {
  stmts.setEffort.run(effort, threadId);
}

export function setModel(threadId: number, model: Model): void {
  stmts.setModel.run(model, threadId);
}

/** Apply a configured Codex preset as one persisted settings change. */
export function setCodexSettings(
  threadId: number,
  model: Model,
  effort: Effort,
  serviceTier: ServiceTier,
): void {
  stmts.setCodexSettings.run(model, effort, serviceTier, threadId);
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
  stmts.del.run(threadId);
}

export function addUsage(threadId: number, u: Usage): void {
  stmts.addUsage.run(u.inTokens, u.outTokens, u.costUsd, threadId);
}

export interface Totals {
  topics: number;
  turns: number;
  in_tokens: number;
  out_tokens: number;
  cost_usd: number;
}

export function totals(): Totals {
  return stmts.totals.get() as unknown as Totals;
}

/** Topics idle past `deleteAfterMs`, whatever their status. */
export function listStale(deleteAfterMs: number): Topic[] {
  return stmts.stale.all(Date.now() - deleteAfterMs) as unknown as Topic[];
}
