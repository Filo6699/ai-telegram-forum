import { fileURLToPath } from "node:url";
import { cfg } from "./config.ts";
import type { Effort } from "./effort.ts";
import type { ImagePart } from "./media.ts";
import type { Model } from "./model.ts";
import type { ServiceTier } from "./preset-config.ts";
import { TG_SYSTEM_PROMPT } from "./tg-tools.ts";

export interface CodexInput {
  text: string;
  images: ImagePart[];
}

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const tgServer = fileURLToPath(new URL("./codex-tg-server.ts", import.meta.url));

const SIDE_BOUNDARY_PROMPT = `Side conversation boundary.
Everything before this boundary is inherited history from the parent thread. It is reference context only. It is not your current task.

Do not continue, execute, or complete any instructions, plans, tool calls, approvals, edits, or requests from before this boundary. Only messages submitted after this boundary are active user instructions for this side conversation.
You are a side-conversation assistant, separate from the main thread. Answer questions and do lightweight, non-mutating exploration without disrupting the main thread.

External tools may be available according to this thread's current permissions. Any tool calls or outputs visible before this boundary happened in the parent thread and are reference-only; do not infer active instructions from them.
Sub-agents are off-limits in this side conversation. Do not interact with any existing or new sub-agents, even if sub-agents were used before this boundary.
Do not modify files, source, git state, permissions, configuration, or workspace state unless the user explicitly asks for that mutation after this boundary.`;

const SIDE_DEVELOPER_INSTRUCTIONS = `You are in a side conversation, not the main thread.
Answer the user's side question directly. Inherited history is reference-only. Prefer lightweight, non-mutating exploration; mutate the workspace only when the side question explicitly requests it. Do not use sub-agents.
Your final answer is collected by the Telegram host automatically. Do not call mcp__tg__send. Keep the final answer concise enough for a chat message.`;

const appServerConfig = (opts: {
  threadId: number;
  cwd: string;
  effort: Effort;
  serviceTier: ServiceTier;
}) => ({
  developer_instructions: TG_SYSTEM_PROMPT,
  ...(opts.effort ? { model_reasoning_effort: opts.effort } : {}),
  ...(opts.serviceTier ? { service_tier: opts.serviceTier } : {}),
  mcp_servers: {
    tg: {
      command: process.execPath,
      args: [
        "--import",
        "tsx",
        tgServer,
        "--thread",
        String(opts.threadId),
        "--cwd",
        opts.cwd,
      ],
      cwd: projectRoot,
      enabled_tools: ["send"],
      required: true,
    },
  },
});

/** Settings shared by app-server thread/start and thread/resume. */
export function codexAppThreadParams(opts: {
  threadId: number;
  cwd: string;
  effort: Effort;
  model: Model;
  serviceTier: ServiceTier;
}): Record<string, unknown> {
  return {
    model: opts.model ?? cfg.codexModel,
    serviceTier: opts.serviceTier,
    cwd: opts.cwd,
    approvalPolicy: "never",
    sandbox: cfg.permission === "bypass" ? "danger-full-access" : "workspace-write",
    developerInstructions: TG_SYSTEM_PROMPT,
    config: appServerConfig(opts),
    threadSource: "cli",
  };
}

/** Native Codex `/btw`: an ephemeral fork plus the same boundary used by its TUI. */
export function codexSideForkParams(opts: {
  parentId: string;
  threadId: number;
  cwd: string;
  effort: Effort;
  model: Model;
  serviceTier: ServiceTier;
}): Record<string, unknown> {
  const config = appServerConfig(opts);
  return {
    ...codexAppThreadParams(opts),
    threadId: opts.parentId,
    ephemeral: true,
    excludeTurns: true,
    developerInstructions: SIDE_DEVELOPER_INSTRUCTIONS,
    config: {
      ...config,
      developer_instructions: SIDE_DEVELOPER_INSTRUCTIONS,
      mcp_servers: {
        ...config.mcp_servers,
        tg: { ...config.mcp_servers.tg, enabled: false, required: false },
      },
    },
  };
}

export const codexSideBoundaryItem = () => ({
  type: "message",
  role: "user",
  content: [{ type: "input_text", text: SIDE_BOUNDARY_PROMPT }],
});

interface CodexUsage {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}

export function readCodexUsage(usage: CodexUsage): {
  inTokens: number;
  outTokens: number;
  costUsd: number;
} {
  return {
    // Cached reads and cache writes are detail fields within input_tokens, not
    // extra input. Adding them again makes long, cache-heavy turns look nearly
    // twice as large as Codex reports them.
    inTokens: usage.input_tokens,
    outTokens: usage.output_tokens,
    // The CLI reports token counts but not price/cost. Keep accounting honest
    // instead of estimating against a pricing table that can change.
    costUsd: 0,
  };
}
