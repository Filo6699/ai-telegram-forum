import type { Query } from "@anthropic-ai/claude-agent-sdk";
import type { Bot } from "grammy";
import type { Effort } from "../config/effort.ts";
import type { Model } from "../config/model.ts";
import type { ServiceTier } from "../config/codex-presets.ts";
import type { Provider } from "../config/provider.ts";
import type { OpenRouterSettings } from "../config/openrouter-presets.ts";
import type { ImagePart } from "../telegram/media.ts";
import type { TgChannel } from "../telegram/tg-tools.ts";
import type { Usage } from "./usage.ts";

export interface AgentInput {
  text: string;
  images: ImagePart[];
}

export interface AgentSettings {
  sessionId: string | null;
  effort: Effort;
  model: Model;
  serviceTier: ServiceTier;
  openrouter: OpenRouterSettings | null;
}

export interface AgentTurnResult {
  ok: boolean;
  usage: Usage;
  failure: string | null;
  stopped: boolean;
  sent: number;
  resolvedModel?: string | null;
}

export interface AgentSideResult extends AgentTurnResult {
  answer: string;
}

export interface AgentSessionHooks {
  beginTurn(): Promise<void>;
  session(id: string): void;
  model?(id: string): void;
  text(value: string): void;
  tool(name: string, input?: unknown): void | Promise<void>;
  endTurn(result: AgentTurnResult): Promise<void>;
}

/**
 * Provider-neutral control surface for a native agent session.
 *
 * Provider transcripts are append-only: this layer may append turns and resume
 * sessions, but it never deletes or replaces provider data. `close()` only
 * stops the live runner, and `interrupt()` preserves input queued for later.
 */
export interface AgentSession {
  readonly controlQuery: Query | null;
  send(input: AgentInput): Promise<void>;
  btw(input: AgentInput, onTool: (name: string) => void): Promise<AgentSideResult>;
  interrupt(): Promise<boolean>;
  applySettings(settings: AgentSettings): Promise<void>;
  suggestTitle(current: string): Promise<string | null>;
  close(): void;
}

export interface AgentSessionOptions extends AgentSettings {
  bot: Bot;
  threadId: number;
  cwd: string;
  provider: Provider;
  channel: TgChannel;
  hooks: AgentSessionHooks;
}
