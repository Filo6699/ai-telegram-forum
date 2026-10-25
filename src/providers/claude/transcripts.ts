import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { claudeResponseCost, type ClaudeTokenUsage } from "./pricing.ts";

/**
 * Read-only spend accounting over Claude Code's own transcripts. Nothing here
 * ever writes under the projects folder.
 */

export interface PricedResponse {
  /** Epoch ms of the transcript line. */
  at: number;
  /** API-equivalent USD; null when the model has no known price. */
  cost: number | null;
}

interface FileState {
  size: number;
  offset: number;
  tail: string;
  responses: Map<string, PricedResponse & { output: number }>;
}

const files = new Map<string, FileState>();

export function claudeProjectsDir(): string {
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
}

/**
 * One API response is written as several lines (one per content block) that
 * repeat the same `message.id`; the last, most complete usage wins.
 */
export function readTranscriptLine(
  line: string,
  into: Map<string, PricedResponse & { output: number }>,
): void {
  if (!line.includes('"assistant"') || !line.includes('"usage"')) return;
  let record: any;
  try {
    record = JSON.parse(line);
  } catch {
    return;
  }
  if (record?.type !== "assistant") return;
  const msg = record.message;
  const id = msg?.id ?? record.requestId;
  const model = msg?.model;
  const usage = msg?.usage as ClaudeTokenUsage | undefined;
  if (typeof id !== "string" || typeof model !== "string" || !usage) return;
  // Locally generated error/interrupt placeholders never reached the API.
  if (model === "<synthetic>") return;
  const at = Date.parse(record.timestamp);
  if (!Number.isFinite(at)) return;
  const output = Number(usage.output_tokens ?? 0);
  const prev = into.get(id);
  if (prev && prev.output > output) return;
  into.set(id, { at: prev?.at ?? at, cost: claudeResponseCost(usage, model), output });
}

/** Incremental: transcripts are append-only, so only new bytes are parsed. */
function load(path: string): FileState["responses"] {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    files.delete(path);
    return new Map();
  }
  let state = files.get(path);
  if (!state || size < state.offset) {
    state = { size: 0, offset: 0, tail: "", responses: new Map() };
    files.set(path, state);
  }
  if (size > state.offset) {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(size - state.offset);
      const read = readSync(fd, buf, 0, buf.length, state.offset);
      state.offset += read;
      const text = state.tail + buf.subarray(0, read).toString("utf8");
      const lines = text.split("\n");
      state.tail = lines.pop() ?? "";
      for (const line of lines) readTranscriptLine(line, state.responses);
    } finally {
      closeSync(fd);
    }
  }
  state.size = size;
  return state.responses;
}

function list(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

const jsonl = (dir: string): string[] =>
  list(dir).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f));

/** A session's own transcript plus the subagents it launched. */
function sessionFiles(projectDir: string, sessionId: string): string[] {
  return [
    join(projectDir, `${sessionId}.jsonl`),
    ...jsonl(join(projectDir, sessionId, "subagents")),
  ];
}

function allFiles(modifiedSince: number): string[] {
  const root = claudeProjectsDir();
  const out: string[] = [];
  for (const project of list(root)) {
    const dir = join(root, project);
    for (const file of jsonl(dir)) {
      out.push(file);
      out.push(...jsonl(join(dir, basename(file, ".jsonl"), "subagents")));
    }
  }
  return out.filter((f) => {
    try {
      return statSync(f).mtimeMs >= modifiedSince;
    } catch {
      return false;
    }
  });
}

export interface Spend {
  usd: number;
  responses: number;
  /** Responses on a model without a price; their cost is missing from `usd`. */
  unpriced: number;
}

function sum(paths: string[], from = -Infinity, to = Infinity): Spend {
  const seen = new Set<string>();
  const spend: Spend = { usd: 0, responses: 0, unpriced: 0 };
  for (const path of paths) {
    for (const [id, r] of load(path)) {
      if (r.at < from || r.at > to || seen.has(id)) continue;
      seen.add(id);
      spend.responses++;
      if (r.cost === null) spend.unpriced++;
      else spend.usd += r.cost;
    }
  }
  return spend;
}

/** Everything one session (and its subagents) has spent, ever. */
export function claudeSessionSpend(sessionId: string): Spend | null {
  const root = claudeProjectsDir();
  for (const project of list(root)) {
    const dir = join(root, project);
    const paths = sessionFiles(dir, sessionId);
    try {
      statSync(paths[0]!);
    } catch {
      continue;
    }
    return sum(paths);
  }
  return null;
}

/** Every local transcript's spend in [from, to] — terminal sessions included. */
export function claudeAccountSpend(from: number, to: number): Spend {
  return sum(allFiles(from), from, to);
}
