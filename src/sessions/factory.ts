import type { AgentSession, AgentSessionOptions } from "./types.ts";
import { ClaudeAgentSession } from "../providers/claude/session.ts";
import { CodexAgentSession } from "../providers/codex/session.ts";
import { OpenRouterAgentSession } from "../providers/openrouter/session.ts";

export function createAgentSession(opts: AgentSessionOptions): AgentSession {
  if (opts.provider === "codex") return new CodexAgentSession(opts);
  if (opts.provider === "openrouter") {
    return new OpenRouterAgentSession(opts);
  }
  return new ClaudeAgentSession(opts);
}
