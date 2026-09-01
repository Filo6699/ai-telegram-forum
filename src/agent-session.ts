import {
  getSessionInfo,
  query,
  type EffortLevel as ClaudeEffortLevel,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Thread as CodexThread, Usage as CodexUsage } from "@openai/codex-sdk";
import type { Bot } from "grammy";
import { queryOptions, readUsage, type Usage } from "./claude.ts";
import {
  codexInput,
  codexToolName,
  createCodexThread,
  isCodexSend,
  readCodexUsage,
  type CodexInput,
} from "./codex.ts";
import { PENDING_TITLE_MARK } from "./cwd.ts";
import type { Effort } from "./effort.ts";
import type { ImagePart } from "./media.ts";
import { defaultModel, type Model } from "./model.ts";
import { clearPermissions } from "./permission.ts";
import type { ServiceTier } from "./preset-config.ts";
import type { Provider } from "./provider.ts";
import { TG_SEND_TOOL, tgSendDelivered, type TgChannel, type TgSendArgs } from "./tg-tools.ts";

export interface AgentInput {
  text: string;
  images: ImagePart[];
}

export interface AgentSettings {
  sessionId: string | null;
  effort: Effort;
  model: Model;
  serviceTier: ServiceTier;
}

export interface AgentTurnResult {
  ok: boolean;
  usage: Usage;
  failure: string | null;
  stopped: boolean;
  sent: number;
}

export interface AgentSessionHooks {
  beginTurn(): Promise<void>;
  session(id: string): void;
  text(value: string): void;
  tool(name: string): void;
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

const zeroUsage = (): Usage => ({ inTokens: 0, outTokens: 0, costUsd: 0 });

// `model` was added to the local adapter when estimated Codex cost was added;
// keeping it optional here also works with the earlier token-only adapter.
const codexUsage = readCodexUsage as unknown as (usage: CodexUsage, model?: Model) => Usage;

function claudeMessage(input: AgentInput): SDKUserMessage {
  const content: SDKUserMessage["message"]["content"] = input.images.length
    ? [
        ...input.images.map((image) => ({
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: image.mediaType as "image/jpeg",
            data: image.data,
          },
        })),
        ...(input.text ? [{ type: "text" as const, text: input.text }] : []),
      ]
    : input.text;
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
  };
}

class ClaudeAgentSession implements AgentSession {
  private pending: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private q: Query | null = null;
  private running = false;
  private closed = false;
  private turnActive = false;
  private stopped = false;
  private stderr = "";
  private settings: AgentSettings;

  constructor(private opts: AgentSessionOptions) {
    this.settings = {
      sessionId: opts.sessionId,
      effort: opts.effort,
      model: opts.model,
      serviceTier: opts.serviceTier,
    };
  }

  get controlQuery(): Query | null {
    return this.q;
  }

  async send(input: AgentInput): Promise<void> {
    this.pending.push(claudeMessage(input));
    this.wake?.();
    this.wake = null;
    if (!this.running) void this.run();
    await this.beginTurn();
  }

  async interrupt(): Promise<boolean> {
    if (!this.turnActive || !this.q) return false;
    this.stopped = true;
    await this.q.interrupt();
    return true;
  }

  async applySettings(settings: AgentSettings): Promise<void> {
    this.settings = { ...settings };
    if (!this.q) return;
    try {
      await this.q.applyFlagSettings({
        effortLevel: settings.effort as ClaudeEffortLevel | null,
      });
    } catch (err) {
      console.warn(`[effort] applying to topic ${this.opts.threadId} failed:`, String(err));
    }
    try {
      await this.q.setModel(settings.model ?? defaultModel("claude"));
    } catch (err) {
      console.warn(`[model] applying to topic ${this.opts.threadId} failed:`, String(err));
    }
  }

  async suggestTitle(): Promise<string | null> {
    if (!this.settings.sessionId) return null;
    const info = await getSessionInfo(this.settings.sessionId);
    const name = info?.summary?.trim();
    if (!name || name === info?.firstPrompt?.trim()) return null;
    return name.slice(0, 128);
  }

  close(): void {
    this.closed = true;
    this.wake?.();
    this.wake = null;
  }

  private async beginTurn(): Promise<void> {
    if (this.turnActive) return;
    this.turnActive = true;
    this.stopped = false;
    this.stderr = "";
    this.opts.channel.resetSent();
    await this.opts.hooks.beginTurn();
  }

  private async finish(ok: boolean, usage: Usage, failure: string | null): Promise<void> {
    const stopped = this.stopped;
    this.turnActive = false;
    this.stopped = false;
    await this.opts.hooks.endTurn({
      ok,
      usage,
      failure,
      stopped,
      sent: this.opts.channel.sent,
    });
  }

  private async *input(): AsyncGenerator<SDKUserMessage> {
    while (!this.closed) {
      if (!this.pending.length) await new Promise<void>((resolve) => (this.wake = resolve));
      while (this.pending.length) yield this.pending.shift()!;
    }
  }

  private async run(): Promise<void> {
    this.running = true;
    this.closed = false;
    try {
      this.q = query({
        prompt: this.input(),
        options: queryOptions({
          bot: this.opts.bot,
          threadId: this.opts.threadId,
          cwd: this.opts.cwd,
          resume: this.settings.sessionId,
          effort: this.settings.effort,
          model: this.settings.model,
          channel: this.opts.channel,
          onStderr: (data) => {
            this.stderr += data;
            console.error(`[claude:${this.opts.threadId}] ${data.trimEnd()}`);
          },
        }),
      });

      for await (const msg of this.q) {
        switch (msg.type) {
          case "system":
            if (msg.subtype === "init") {
              this.settings.sessionId = msg.session_id;
              this.opts.hooks.session(msg.session_id);
            }
            break;

          case "assistant": {
            await this.beginTurn();
            const said: string[] = [];
            for (const block of msg.message.content) {
              if (block.type === "text") said.push(block.text);
              else if (block.type === "tool_use" && block.name !== TG_SEND_TOOL) {
                this.opts.hooks.tool(block.name);
              }
            }
            const text = said.join("");
            if (text.trim() && !msg.parent_tool_use_id) this.opts.hooks.text(text);
            break;
          }

          case "result": {
            this.settings.sessionId = msg.session_id;
            this.opts.hooks.session(msg.session_id);
            const ok = msg.subtype === "success";
            if (ok && typeof (msg as any).result === "string") {
              this.opts.hooks.text((msg as any).result);
            }
            const failure =
              !ok && !this.stopped
                ? `⚠️ ${msg.subtype}: ${(msg as any).error ?? ""}`
                : null;
            await this.finish(ok, readUsage(msg), failure);
            break;
          }
        }
      }
    } catch (err) {
      const detail = this.stderr.trim().split("\n").filter(Boolean).slice(-5).join("\n");
      const failure = this.stopped
        ? null
        : `❌ ${String(err)}` + (detail ? `\n\n\`\`\`\n${detail}\n\`\`\`` : "");
      console.error(`[claude:${this.opts.threadId}] session died:`, err);
      if (this.turnActive) await this.finish(false, zeroUsage(), failure);
    } finally {
      this.running = false;
      this.q = null;
      clearPermissions(this.opts.threadId);
      if (!this.closed && this.pending.length) void this.run();
    }
  }
}

class CodexAgentSession implements AgentSession {
  private pending: CodexInput[] = [];
  private thread: CodexThread | null = null;
  private abort: AbortController | null = null;
  private running = false;
  private closed = false;
  private turnActive = false;
  private stopped = false;
  private sent = 0;
  private failure: string | null = null;
  private settings: AgentSettings;

  constructor(private opts: AgentSessionOptions) {
    this.settings = {
      sessionId: opts.sessionId,
      effort: opts.effort,
      model: opts.model,
      serviceTier: opts.serviceTier,
    };
  }

  get controlQuery(): Query | null {
    return null;
  }

  async send(input: AgentInput): Promise<void> {
    this.pending.push(input);
    if (!this.running) void this.run();
  }

  async interrupt(): Promise<boolean> {
    if (!this.turnActive || !this.abort) return false;
    this.stopped = true;
    this.abort.abort();
    return true;
  }

  async applySettings(settings: AgentSettings): Promise<void> {
    this.settings = { ...settings };
    this.resetThread();
  }

  async suggestTitle(current: string): Promise<string | null> {
    return current.slice(PENDING_TITLE_MARK.length);
  }

  close(): void {
    this.closed = true;
    this.abort?.abort();
  }

  private resetThread(): void {
    this.thread = createCodexThread({
      threadId: this.opts.threadId,
      cwd: this.opts.cwd,
      sessionId: this.settings.sessionId,
      effort: this.settings.effort,
      model: this.settings.model,
      serviceTier: this.settings.serviceTier,
    });
  }

  private async beginTurn(): Promise<void> {
    this.turnActive = true;
    this.stopped = false;
    this.sent = 0;
    this.failure = null;
    await this.opts.hooks.beginTurn();
  }

  private async finish(ok: boolean, usage: Usage): Promise<void> {
    const result: AgentTurnResult = {
      ok,
      usage,
      failure: this.failure,
      stopped: this.stopped,
      sent: this.sent,
    };
    this.turnActive = false;
    this.stopped = false;
    this.failure = null;
    await this.opts.hooks.endTurn(result);
  }

  private async run(): Promise<void> {
    this.running = true;
    this.closed = false;
    if (!this.thread) this.resetThread();

    try {
      while (!this.closed && this.pending.length) {
        const batch = this.pending.splice(0);
        const input: CodexInput = {
          text: batch.map((message) => message.text).filter(Boolean).join("\n\n"),
          images: batch.flatMap((message) => message.images),
        };
        this.abort = new AbortController();
        await this.beginTurn();
        const streamed = await this.thread!.runStreamed(codexInput(input), {
          signal: this.abort.signal,
        });
        let terminal = false;

        for await (const event of streamed.events) {
          switch (event.type) {
            case "thread.started":
              this.settings.sessionId = event.thread_id;
              this.opts.hooks.session(event.thread_id);
              break;

            case "item.started": {
              const name = codexToolName(event.item);
              if (name) this.opts.hooks.tool(name);
              break;
            }

            case "item.completed":
              if (event.item.type === "agent_message" && event.item.text.trim()) {
                this.opts.hooks.text(event.item.text);
              } else if (
                isCodexSend(event.item) &&
                event.item.type === "mcp_tool_call" &&
                event.item.status === "completed"
              ) {
                const result = await this.opts.channel.send(event.item.arguments as TgSendArgs);
                if (tgSendDelivered(result)) this.sent++;
                else if (!this.failure) {
                  this.failure = `⚠️ Telegram delivery failed: ${result.content[0]?.text ?? "unknown error"}`;
                }
              } else if (event.item.type === "error" && !this.failure) {
                this.failure = `⚠️ ${event.item.message}`;
              }
              break;

            case "turn.completed":
              terminal = true;
              await this.finish(true, codexUsage(event.usage, this.settings.model));
              break;

            case "turn.failed":
              if (!this.stopped) this.failure = `⚠️ ${event.error.message}`;
              terminal = true;
              await this.finish(false, zeroUsage());
              break;

            case "error":
              if (!this.stopped) this.failure = `⚠️ ${event.message}`;
              break;
          }
        }

        if (!terminal && this.turnActive) {
          if (!this.stopped) this.failure ??= "⚠️ Codex ended without a turn result";
          await this.finish(false, zeroUsage());
        }
        this.abort = null;
      }
    } catch (err) {
      if (!this.stopped) {
        this.failure = `❌ ${String(err)}`;
        console.error(`[codex:${this.opts.threadId}] session died:`, err);
      }
      if (this.turnActive) await this.finish(false, zeroUsage());
    } finally {
      this.running = false;
      this.abort = null;
      clearPermissions(this.opts.threadId);
      if (!this.closed && this.pending.length) void this.run();
    }
  }
}

export function createAgentSession(opts: AgentSessionOptions): AgentSession {
  return opts.provider === "codex" ? new CodexAgentSession(opts) : new ClaudeAgentSession(opts);
}
