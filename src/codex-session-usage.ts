import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { codexRequest } from "./codex-app-server.ts";
import {
  estimateCodexCredits,
  estimateCodexWeeklyPercent,
  type CodexTokenBreakdown,
} from "./codex-quota.ts";
import type { ServiceTier } from "./preset-config.ts";

const BASELINE_TOKENS = 12_000;

interface ThreadReadResult {
  thread?: { path?: string | null } | null;
}

const rolloutPaths = new Map<string, string>();

interface TokenUsage extends CodexTokenBreakdown {
  total_tokens?: number;
}

interface RolloutLine {
  type?: string;
  payload?: {
    type?: string;
    model?: string | null;
    service_tier?: ServiceTier;
    item?: {
      type?: string;
      receiver_thread_ids?: unknown;
    };
    info?: {
      total_token_usage?: TokenUsage;
      last_token_usage?: TokenUsage;
      model_context_window?: number | null;
    } | null;
  };
}

export interface ParsedCodexRollout {
  usage: CodexSessionUsage | null;
  childThreadIds: string[];
}

export interface CodexSessionUsage {
  totalTokens: number;
  contextUsedPercent: number | null;
  estimatedWeeklyPercent: number | null;
}

class SessionUsageParser {
  private model: string | null = null;
  private serviceTier: ServiceTier = null;
  private totalTokens = 0;
  private estimatedCredits = 0;
  private pricedResponses = 0;
  private contextUsedPercent: number | null = null;
  private responses = 0;
  private children = new Set<string>();

  line(line: string): void {
    const hasUsage = line.includes('"token_count"') || line.includes('"turn_context"');
    const hasChildren = line.includes('"CollabAgentToolCall"');
    if (!hasUsage && !hasChildren) return;
    let record: RolloutLine;
    try {
      record = JSON.parse(line) as RolloutLine;
    } catch {
      return;
    }
    if (record.payload?.item?.type === "CollabAgentToolCall") {
      for (const id of Array.isArray(record.payload.item.receiver_thread_ids)
        ? record.payload.item.receiver_thread_ids
        : []) {
        if (typeof id === "string" && id) this.children.add(id);
      }
    }
    if (!hasUsage) return;
    if (record.type === "turn_context") {
      this.model = record.payload?.model ?? this.model;
      this.serviceTier = record.payload?.service_tier ?? null;
      return;
    }
    if (record.type !== "event_msg" || record.payload?.type !== "token_count") return;
    const info = record.payload.info;
    const last = info?.last_token_usage;
    if (!last) return;
    this.responses++;

    const responseTokens = last.total_tokens;
    if (Number.isFinite(responseTokens)) this.totalTokens += responseTokens!;
    else {
      this.totalTokens += Math.max(0, Number(last.input_tokens ?? 0));
      this.totalTokens += Math.max(0, Number(last.output_tokens ?? 0));
    }

    if (this.model) {
      const credits = estimateCodexCredits(last, this.model, this.serviceTier);
      if (credits !== null) {
        this.estimatedCredits += credits;
        this.pricedResponses++;
      }
    }

    const contextTokens = last.total_tokens;
    const contextWindow = info?.model_context_window;
    if (
      Number.isFinite(contextTokens) &&
      Number.isFinite(contextWindow) &&
      contextWindow! > BASELINE_TOKENS
    ) {
      const effective = contextWindow! - BASELINE_TOKENS;
      const used = Math.max(0, contextTokens! - BASELINE_TOKENS);
      this.contextUsedPercent = Math.round(Math.min(100, (used / effective) * 100));
    }
  }

  result(): CodexSessionUsage | null {
    if (!this.responses) return null;
    return {
      totalTokens: this.totalTokens,
      contextUsedPercent: this.contextUsedPercent,
      estimatedWeeklyPercent:
        this.pricedResponses === this.responses
          ? estimateCodexWeeklyPercent(this.estimatedCredits)
          : null,
    };
  }

  childThreadIds(): string[] {
    return [...this.children];
  }
}

/** Parse all native response usage in one append-only rollout. */
export function parseCodexRollout(text: string): ParsedCodexRollout {
  const parser = new SessionUsageParser();
  for (const line of text.split("\n")) parser.line(line);
  return { usage: parser.result(), childThreadIds: parser.childThreadIds() };
}

export function parseCodexSessionUsage(text: string): CodexSessionUsage | null {
  return parseCodexRollout(text).usage;
}

async function readRolloutUsage(path: string): Promise<ParsedCodexRollout> {
  const parser = new SessionUsageParser();
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) parser.line(line);
  return { usage: parser.result(), childThreadIds: parser.childThreadIds() };
}

/** Add native usage from a parent rollout and its child-agent rollouts. */
export function mergeCodexSessionUsage(usages: CodexSessionUsage[]): CodexSessionUsage | null {
  if (!usages.length) return null;
  const first = usages[0]!;
  return {
    totalTokens: usages.reduce((sum, usage) => sum + usage.totalTokens, 0),
    // Context occupancy belongs to the parent conversation, whose usage is
    // intentionally first in the list. Child contexts must not be added.
    contextUsedPercent: first.contextUsedPercent,
    estimatedWeeklyPercent: usages.every((usage) => usage.estimatedWeeklyPercent !== null)
      ? usages.reduce((sum, usage) => sum + usage.estimatedWeeklyPercent!, 0)
      : null,
  };
}

async function rolloutPath(sessionId: string): Promise<string | null> {
  const cached = rolloutPaths.get(sessionId);
  if (cached) return cached;
  const result = await codexRequest<ThreadReadResult>("thread/read", {
    threadId: sessionId,
    includeTurns: false,
  });
  const path = result.thread?.path ?? null;
  if (path) rolloutPaths.set(sessionId, path);
  return path;
}

/** Native cumulative usage and current context occupancy for a Codex thread tree. */
export async function fetchCodexSessionUsage(
  sessionId: string,
): Promise<CodexSessionUsage | null> {
  const rootPath = await rolloutPath(sessionId);
  if (!rootPath) return null;

  const pending = [{ sessionId, path: rootPath }];
  const visited = new Set<string>();
  const usages: CodexSessionUsage[] = [];

  while (pending.length) {
    const current = pending.shift()!;
    if (visited.has(current.sessionId)) continue;
    visited.add(current.sessionId);

    let parsed: ParsedCodexRollout;
    try {
      parsed = await readRolloutUsage(current.path);
    } catch (err) {
      console.warn(`[usage] reading Codex rollout ${current.sessionId} failed:`, String(err));
      continue;
    }
    if (parsed.usage) usages.push(parsed.usage);

    for (const childId of parsed.childThreadIds) {
      if (visited.has(childId)) continue;
      try {
        const childPath = await rolloutPath(childId);
        if (childPath) pending.push({ sessionId: childId, path: childPath });
      } catch (err) {
        // A child can still be starting when the parent status line refreshes.
        // It will be discovered again on the next refresh.
        console.warn(`[usage] reading Codex child ${childId} failed:`, String(err));
      }
    }
  }

  return mergeCodexSessionUsage(usages);
}
