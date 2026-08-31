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

interface TokenCountLine {
  type?: string;
  payload?: {
    type?: string;
    model?: string | null;
    service_tier?: ServiceTier;
    info?: {
      total_token_usage?: TokenUsage;
      last_token_usage?: TokenUsage;
      model_context_window?: number | null;
    } | null;
  };
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

  line(line: string): void {
    if (!line.includes('"token_count"') && !line.includes('"turn_context"')) return;
    let record: TokenCountLine;
    try {
      record = JSON.parse(line) as TokenCountLine;
    } catch {
      return;
    }
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
}

/** Parse all native response usage in one append-only rollout. */
export function parseCodexSessionUsage(text: string): CodexSessionUsage | null {
  const parser = new SessionUsageParser();
  for (const line of text.split("\n")) parser.line(line);
  return parser.result();
}

async function readRolloutUsage(path: string): Promise<CodexSessionUsage | null> {
  const parser = new SessionUsageParser();
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) parser.line(line);
  return parser.result();
}

/** Native cumulative usage and current context occupancy for one Codex thread. */
export async function fetchCodexSessionUsage(
  sessionId: string,
): Promise<CodexSessionUsage | null> {
  let path = rolloutPaths.get(sessionId);
  if (!path) {
    const result = await codexRequest<ThreadReadResult>("thread/read", {
      threadId: sessionId,
      includeTurns: false,
    });
    path = result.thread?.path ?? undefined;
    if (path) rolloutPaths.set(sessionId, path);
  }
  if (!path) return null;
  return readRolloutUsage(path);
}
