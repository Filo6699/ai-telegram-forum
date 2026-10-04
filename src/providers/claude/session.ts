import { getSessionInfo, query, type EffortLevel as ClaudeEffortLevel, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { queryOptions, readUsage } from "./options.ts";
import { defaultModel } from "../../config/model.ts";
import { TG_SEND_TOOL } from "../../telegram/tg-tools.ts";
import type { AgentInput, AgentSession, AgentSessionOptions, AgentSettings, AgentSideResult } from "../../sessions/types.ts";
import { zeroUsage, type Usage } from "../../sessions/usage.ts";
import { clearPermissions } from "../../telegram/permission.ts";

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

  constructor(private opts: AgentSessionOptions) {
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

  async send(input: AgentInput): Promise<void> {
    this.pending.push(claudeMessage(input));
    this.wake?.();
    this.wake = null;
    if (!this.running) void this.run();
    await this.beginTurn();
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
                await this.opts.hooks.tool(block.name, block.input);
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
