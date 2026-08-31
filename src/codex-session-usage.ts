import { open } from "node:fs/promises";
import { codexRequest } from "./codex-app-server.ts";

const BASELINE_TOKENS = 12_000;
const CHUNK_BYTES = 256 * 1024;
const MAX_TAIL_BYTES = 8 * 1024 * 1024;

interface ThreadReadResult {
  thread?: { path?: string | null } | null;
}

interface TokenUsage {
  total_tokens?: number;
}

interface TokenCountLine {
  type?: string;
  payload?: {
    type?: string;
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
}

/** Parse the newest native token_count record found in a rollout tail. */
export function parseCodexSessionUsage(text: string): CodexSessionUsage | null {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line?.includes('"token_count"')) continue;
    let record: TokenCountLine;
    try {
      record = JSON.parse(line) as TokenCountLine;
    } catch {
      continue;
    }
    if (record.type !== "event_msg" || record.payload?.type !== "token_count") continue;
    const info = record.payload.info;
    const totalTokens = info?.total_token_usage?.total_tokens;
    if (!Number.isFinite(totalTokens)) continue;

    const contextTokens = info?.last_token_usage?.total_tokens;
    const contextWindow = info?.model_context_window;
    let contextUsedPercent: number | null = null;
    if (
      Number.isFinite(contextTokens) &&
      Number.isFinite(contextWindow) &&
      contextWindow! > BASELINE_TOKENS
    ) {
      const effective = contextWindow! - BASELINE_TOKENS;
      const used = Math.max(0, contextTokens! - BASELINE_TOKENS);
      contextUsedPercent = Math.round(Math.min(100, (used / effective) * 100));
    }
    return { totalTokens: totalTokens!, contextUsedPercent };
  }
  return null;
}

async function readRolloutTail(path: string): Promise<string> {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    let bytes = Math.min(size, CHUNK_BYTES);
    while (bytes <= Math.min(size, MAX_TAIL_BYTES)) {
      const buffer = Buffer.alloc(bytes);
      await file.read(buffer, 0, bytes, size - bytes);
      const text = buffer.toString("utf8");
      if (parseCodexSessionUsage(text) || bytes === size || bytes === MAX_TAIL_BYTES) return text;
      bytes = Math.min(size, MAX_TAIL_BYTES, bytes * 2);
    }
    return "";
  } finally {
    await file.close();
  }
}

/** Native cumulative usage and current context occupancy for one Codex thread. */
export async function fetchCodexSessionUsage(
  sessionId: string,
): Promise<CodexSessionUsage | null> {
  const result = await codexRequest<ThreadReadResult>("thread/read", {
    threadId: sessionId,
    includeTurns: false,
  });
  const path = result.thread?.path;
  if (!path) return null;
  return parseCodexSessionUsage(await readRolloutTail(path));
}
