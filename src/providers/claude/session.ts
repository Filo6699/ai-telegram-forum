import { getSessionInfo, query, type EffortLevel as ClaudeEffortLevel, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { queryOptions, readUsage } from "./options.ts";
import { defaultModel } from "../../config/model.ts";
import { TG_SEND_TOOL } from "../../telegram/tg-tools.ts";
import type { AgentInput, AgentSession, AgentSessionOptions, AgentSettings, AgentSideResult } from "../../sessions/types.ts";
import { zeroUsage, type Usage } from "../../sessions/usage.ts";
import { clearPermissions } from "../../telegram/permission.ts";
import { isQuotaFailure, QUOTA_CONTINUATION } from "../../sessions/quota-retry.ts";

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

export class ClaudeAgentSession implements AgentSession {
  private pending: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private q: Query | null = null;
  private running = false;
  private closed = false;
  private turnActive = false;
  private stopped = false;
  private stderr = "";
  private settings: AgentSettings;
  private lastInput: SDKUserMessage | null = null;
  private quotaInput: SDKUserMessage | null = null;
  private apiFailure: string | null = null;
  private quotaRejected = false;
  private quotaResetsAt: string | null = null;
  private tasks = 0;
  // A /compact turn reports success only through its compact_boundary.
  private compactTurn = false;
  private compactDone = false;
  private compactError: string | null = null;

  constructor(private opts: AgentSessionOptions, private startQuery = query) {
    this.settings = {
      sessionId: opts.sessionId,
      effort: opts.effort,
      model: opts.model,
      serviceTier: opts.serviceTier,
      openrouter: opts.openrouter,
    };
  }

  get controlQuery(): Query | null {
    return this.q;
  }

  get backgroundTasks(): number {
    return this.tasks;
  }

  async send(input: AgentInput): Promise<void> {
    this.quotaInput = null;
    this.pending.push(claudeMessage(input));
    this.wake?.();
    this.wake = null;
    if (!this.running) void this.run();
    await this.beginTurn();
  }

  async retryQuota(): Promise<boolean> {
    if (this.closed || !this.quotaInput || this.turnActive || this.pending.length) return false;
    const input = this.quotaInput;
    this.quotaInput = null;
    this.pending.push(input);
    this.wake?.();
    this.wake = null;
    if (!this.running) void this.run();
    await this.beginTurn();
    return true;
  }

  async compact(instructions: string): Promise<boolean> {
    if (this.closed || this.turnActive) return false;
    this.quotaInput = null;
    // Claude Code runs slash commands that arrive as prompt text.
    this.pending.push(claudeMessage({ text: `/compact ${instructions}`.trim(), images: [] }));
    this.wake?.();
    this.wake = null;
    if (!this.running) void this.run();
    await this.beginTurn(true);
    return true;
  }

  async btw(input: AgentInput): Promise<AgentSideResult> {
    if (input.images.length) throw new Error("Claude /btw currently accepts text only");
    // Claude Code exposes side_question on its streaming control transport,
    // but the SDK's Query declaration has not caught up with the runtime API.
    if (!this.running) void this.run();
    await Promise.resolve();
    const q = this.q as
      | (Query & {
          askSideQuestion(
            question: string,
          ): Promise<{ response: string; synthetic: boolean } | null>;
        })
      | null;
    if (!q?.askSideQuestion) throw new Error("this Claude Code version does not expose /btw");
    const result = await q.askSideQuestion(input.text);
    return {
      ok: result !== null,
      usage: zeroUsage(),
      failure: result ? null : "⚠️ Claude returned no side answer",
      stopped: false,
      sent: 0,
      answer: result?.response ?? "",
    };
  }

  async interrupt(): Promise<boolean> {
    if (!this.turnActive && this.quotaInput) {
      this.quotaInput = null;
      return true;
    }
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
    this.quotaInput = null;
    this.wake?.();
    this.wake = null;
    // Ending the input closes the CLI's stdin, but a CLI with background tasks
    // keeps running and starts turns when they report back. Those turns can't
    // reach the tg tool or the bot, so stop the process instead.
    if (this.tasks) this.q?.close();
  }

  private async beginTurn(compact = false): Promise<void> {
    if (this.turnActive) return;
    this.turnActive = true;
    this.compactTurn = compact;
    this.compactDone = false;
    this.compactError = null;
    this.stopped = false;
    this.stderr = "";
    this.apiFailure = null;
    this.quotaRejected = false;
    this.quotaResetsAt = null;
    this.opts.channel.resetSent();
    await this.opts.hooks.beginTurn();
  }

  private async finish(ok: boolean, usage: Usage, failure: string | null): Promise<void> {
    const stopped = this.stopped;
    this.quotaInput = !ok && !stopped && !this.compactTurn && !this.closed && isQuotaFailure(failure)
      ? this.settings.sessionId ? claudeMessage({ text: QUOTA_CONTINUATION, images: [] }) : this.lastInput
      : null;
    this.turnActive = false;
    this.stopped = false;
    await this.opts.hooks.endTurn({
      ok,
      usage,
      failure,
      stopped,
      sent: this.opts.channel.sent,
      quotaResetsAt: this.quotaResetsAt,
    });
  }

  private async *input(): AsyncGenerator<SDKUserMessage> {
    while (!this.closed) {
      if (!this.pending.length) await new Promise<void>((resolve) => (this.wake = resolve));
      while (!this.closed && this.pending.length) {
        this.lastInput = this.pending.shift()!;
        yield this.lastInput;
      }
    }
  }

  private async run(): Promise<void> {
    this.running = true;
    this.closed = false;
    this.tasks = 0;
    try {
      this.q = this.startQuery({
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
            } else if (msg.subtype === "background_tasks_changed") {
              this.tasks = msg.tasks.filter((task) => !task.ambient).length;
            } else if (msg.subtype === "status") {
              if (msg.status === "compacting") this.opts.hooks.compacting?.();
              else if (msg.compact_result === "failed") {
                this.compactError = msg.compact_error ?? null;
                this.opts.hooks.compacted?.({ ok: false, preTokens: null, postTokens: null });
              }
            } else if (msg.subtype === "compact_boundary") {
              this.compactDone = true;
              const meta = msg.compact_metadata;
              this.opts.hooks.compacted?.({ ok: true, preTokens: meta.pre_tokens, postTokens: meta.post_tokens ?? null });
            }
            break;

          case "assistant": {
            await this.beginTurn();
            const said: string[] = [];
            for (const block of msg.message.content) {
              if (block.type === "text") said.push(block.text);
              else if (block.type === "tool_use" && block.name !== TG_SEND_TOOL) {
                await this.opts.hooks.tool(block.name, block.input);
              }
            }
            const text = said.join("");
            if (msg.error && !msg.parent_tool_use_id) this.apiFailure = text || String(msg.error);
            // A command that can't run, like /compact on an empty session,
            // answers with a synthetic message instead of an error result.
            if (this.compactTurn && text.trim() && !msg.parent_tool_use_id) this.compactError ??= text.trim();
            if (text.trim() && !msg.parent_tool_use_id) this.opts.hooks.text(text);
            break;
          }

          case "rate_limit_event":
            if (msg.rate_limit_info.status === "rejected" && /^(five_hour|seven_day)/.test(msg.rate_limit_info.rateLimitType ?? "")) {
              this.quotaRejected = true;
              if (msg.rate_limit_info.resetsAt) this.quotaResetsAt = new Date(msg.rate_limit_info.resetsAt * 1000).toISOString();
            }
            break;

          case "result": {
            this.settings.sessionId = msg.session_id;
            this.opts.hooks.session(msg.session_id);
            const compactFailure = this.compactTurn && !this.compactDone
              ? this.compactError ?? "Compaction failed" : null;
            const ok = msg.subtype === "success" && !msg.is_error && !this.apiFailure && !compactFailure;
            if (ok && typeof (msg as any).result === "string") {
              this.opts.hooks.text((msg as any).result);
            }
            const detail = this.apiFailure ?? compactFailure ?? (msg.subtype === "success" ? msg.result : msg.errors.join("\n"));
            const failure = !ok && !this.stopped
              ? `⚠️ ${this.quotaRejected ? "Subscription usage limit reached. " : ""}${detail || msg.subtype}` : null;
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
      this.tasks = 0;
      this.q = null;
      clearPermissions(this.opts.threadId);
      if (!this.closed && this.pending.length) void this.run();
    }
  }
}
