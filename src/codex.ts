import { fileURLToPath } from "node:url";
import {
  Codex,
  type Input,
  type ModelReasoningEffort,
  type Thread,
  type ThreadItem,
  type Usage as CodexUsage,
} from "@openai/codex-sdk";
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

export function codexInput(input: CodexInput): Input {
  const parts: Exclude<Input, string> = input.images.map((image) => ({
    type: "local_image",
    path: image.path,
  }));
  // The SDK passes images as `--image` flags and sends only text parts to the
  // CLI over stdin. An image-only input therefore needs a non-empty prompt or
  // `codex exec` exits before it ever opens the image.
  const text = input.text.trim()
    ? input.text
    : input.images.length
      ? "Examine the attached image."
      : "";
  if (text) parts.unshift({ type: "text", text });
  return parts.length ? parts : "[image]";
}

export function createCodexThread(opts: {
  threadId: number;
  cwd: string;
  sessionId: string | null;
  effort: Effort;
  model: Model;
  serviceTier: ServiceTier;
}): Thread {
  const codex = new Codex({
    config: {
      developer_instructions: TG_SYSTEM_PROMPT,
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
    },
  });
  const options = {
    workingDirectory: opts.cwd,
    skipGitRepoCheck: true,
    threadSource: "cli",
    model: opts.model ?? cfg.codexModel,
    ...(opts.effort
      ? { modelReasoningEffort: opts.effort as ModelReasoningEffort }
      : {}),
    approvalPolicy: "never" as const,
    sandboxMode:
      cfg.permission === "bypass" ? ("danger-full-access" as const) : ("workspace-write" as const),
    networkAccessEnabled: true,
    webSearchMode: "live" as const,
  };
  return opts.sessionId
    ? codex.resumeThread(opts.sessionId, options)
    : codex.startThread(options);
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

export function codexToolName(item: ThreadItem): string | null {
  switch (item.type) {
    case "command_execution":
      return "Shell";
    case "file_change":
      return "apply_patch";
    case "web_search":
      return "web_search";
    case "mcp_tool_call":
      return item.server === "tg" && item.tool === "send"
        ? null
        : `mcp__${item.server}__${item.tool}`;
    case "todo_list":
      return "update_plan";
    default:
      return null;
  }
}

export const isCodexSend = (item: ThreadItem): boolean =>
  item.type === "mcp_tool_call" && item.server === "tg" && item.tool === "send";
