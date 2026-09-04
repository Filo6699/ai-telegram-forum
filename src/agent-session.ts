import {
  getSessionInfo,
  query,
  type EffortLevel as ClaudeEffortLevel,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Bot } from "grammy";
import { queryOptions, readUsage, type Usage } from "./claude.ts";
import {
  codexAppThreadParams,
  codexSideBoundaryItem,
  codexSideForkParams,
  readCodexUsage,
  type CodexInput,
} from "./codex.ts";
import { CodexAppServerClient, type AppServerNotification } from "./codex-app-server-client.ts";
import { cfg } from "./config.ts";
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

export interface AgentSideResult extends AgentTurnResult {
  answer: string;
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

const zeroUsage = (): Usage => ({ inTokens: 0, outTokens: 0, costUsd: 0 });

// Keep the app-server adapter compatible with the earlier token-only helper as
// well as the newer model-priced helper while that accounting work is local.
const codexUsage = readCodexUsage as unknown as (usage: any, model?: Model) => Usage;

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
  private server = new CodexAppServerClient();
  private parentId: string | null = null;
  private opening: Promise<string> | null = null;
  private activeTurnId: string | null = null;
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

  async btw(input: AgentInput, onTool: (name: string) => void): Promise<AgentSideResult> {
    const parentId = await this.ensureThread();
    const fork = await this.server.request<{ thread: { id: string } }>(
      "thread/fork",
      codexSideForkParams({
        parentId,
        threadId: this.opts.threadId,
        cwd: this.opts.cwd,
        effort: this.settings.effort,
        model: this.settings.model,
        serviceTier: this.settings.serviceTier,
      }),
    );
    const sideId = fork.thread.id;
    try {
      await this.server.request("thread/inject_items", {
        threadId: sideId,
        items: [codexSideBoundaryItem()],
      });
      return await this.runAppTurn(sideId, input, {
        onTool,
        deliverTelegram: false,
      });
    } finally {
      await this.server.request("thread/unsubscribe", { threadId: sideId }).catch((err) => {
        console.warn(`[btw:${this.opts.threadId}] discarding side thread failed:`, String(err));
      });
    }
  }

  async interrupt(): Promise<boolean> {
    if (!this.turnActive || !this.parentId || !this.activeTurnId) return false;
    this.stopped = true;
    await this.server.request("turn/interrupt", {
      threadId: this.parentId,
      turnId: this.activeTurnId,
    });
    return true;
  }

  async applySettings(settings: AgentSettings): Promise<void> {
    this.settings = { ...settings };
  }

  async suggestTitle(current: string): Promise<string | null> {
    return current.slice(PENDING_TITLE_MARK.length);
  }

  close(): void {
    this.closed = true;
    this.server.close();
  }

  private async ensureThread(): Promise<string> {
    if (this.parentId) return this.parentId;
    if (this.opening) return this.opening;
    this.opening = (async () => {
      const common = codexAppThreadParams({
        threadId: this.opts.threadId,
        cwd: this.opts.cwd,
        effort: this.settings.effort,
        model: this.settings.model,
        serviceTier: this.settings.serviceTier,
      });
      const result = this.settings.sessionId
        ? await this.server.request<{ thread: { id: string } }>("thread/resume", {
            ...common,
            threadId: this.settings.sessionId,
            excludeTurns: true,
          })
        : await this.server.request<{ thread: { id: string } }>("thread/start", common);
      this.parentId = result.thread.id;
      this.settings.sessionId = result.thread.id;
      this.opts.hooks.session(result.thread.id);
      return result.thread.id;
    })();
    try {
      return await this.opening;
    } finally {
      this.opening = null;
    }
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

    try {
      while (!this.closed && this.pending.length) {
        const batch = this.pending.splice(0);
        const input: CodexInput = {
          text: batch.map((message) => message.text).filter(Boolean).join("\n\n"),
          images: batch.flatMap((message) => message.images),
        };
        await this.beginTurn();
        const parentId = await this.ensureThread();
        const result = await this.runAppTurn(parentId, input, {
          onTool: (name) => this.opts.hooks.tool(name),
          deliverTelegram: true,
        });
        this.failure = result.failure;
        this.sent = result.sent;
        this.stopped = result.stopped;
        await this.finish(result.ok, result.usage);
      }
    } catch (err) {
      if (!this.stopped) {
        this.failure = `❌ ${String(err)}`;
        console.error(`[codex:${this.opts.threadId}] session died:`, err);
      }
      if (this.turnActive) await this.finish(false, zeroUsage());
    } finally {
      this.running = false;
      this.activeTurnId = null;
      clearPermissions(this.opts.threadId);
      if (!this.closed && this.pending.length) void this.run();
    }
  }

  private async runAppTurn(
    threadId: string,
    input: CodexInput,
    options: { onTool(name: string): void; deliverTelegram: boolean },
  ): Promise<AgentSideResult> {
    let turnId: string | null = null;
    let answer = "";
    let hasFinalAnswer = false;
    let usage = zeroUsage();
    let failure: string | null = null;
    let sent = 0;
    const deliveries: Promise<void>[] = [];

    let settle!: (result: AgentSideResult) => void;
    let reject!: (error: Error) => void;
    const completed = new Promise<AgentSideResult>((resolve, rejectResult) => {
      settle = resolve;
      reject = rejectResult;
    });

    const belongs = (params: any): boolean =>
      params?.threadId === threadId && (!turnId || !params.turnId || params.turnId === turnId);
    const onNotification = (event: AppServerNotification) => {
      if (event.method === "client/closed") {
        this.parentId = null;
        this.activeTurnId = null;
        reject(event.params.error);
        return;
      }
      const params = event.params;
      if (!belongs(params)) return;

      if (event.method === "turn/started") {
        turnId ??= params.turn.id;
        if (threadId === this.parentId) this.activeTurnId = turnId;
      } else if (event.method === "item/started") {
        const name = appServerToolName(params.item);
        if (name) options.onTool(name);
      } else if (event.method === "item/completed") {
        const item = params.item;
        if (item.type === "agentMessage" && item.text?.trim()) {
          if (item.phase === "final_answer") {
            answer = item.text;
            hasFinalAnswer = true;
          } else if (!hasFinalAnswer) {
            answer = item.text;
          }
          if (options.deliverTelegram) this.opts.hooks.text(item.text);
        } else if (
          options.deliverTelegram &&
          item.type === "mcpToolCall" &&
          item.server === "tg" &&
          item.tool === "send" &&
          item.status === "completed"
        ) {
          deliveries.push(
            this.opts.channel
              .send(item.arguments as TgSendArgs)
              .then((result) => {
                if (tgSendDelivered(result)) sent++;
                else failure ??= `⚠️ Telegram delivery failed: ${result.content[0]?.text ?? "unknown error"}`;
              })
              .catch((err) => {
                failure ??= `⚠️ Telegram delivery failed: ${String(err)}`;
              }),
          );
        }
      } else if (event.method === "thread/tokenUsage/updated") {
        const last = params.tokenUsage?.last;
        if (last) usage = appServerUsage(last, this.settings.model);
      } else if (event.method === "error" && !params.willRetry) {
        failure ??= `⚠️ ${params.error?.message ?? "Codex turn failed"}`;
      } else if (event.method === "turn/completed") {
        const status = params.turn.status;
        void Promise.all(deliveries).then(() => {
          settle({
            ok: status === "completed",
            stopped: status === "interrupted",
            failure:
              failure ??
              (status === "failed" ? `⚠️ ${params.turn.error?.message ?? "Codex turn failed"}` : null),
            usage,
            sent,
            answer,
          });
        });
      }
    };
    const off = this.server.onNotification(onNotification);
    try {
      const started = await this.server.request<{ turn: { id: string } }>("turn/start", {
        threadId,
        input: appServerInput(input),
        model: this.settings.model ?? cfg.codexModel,
        effort: this.settings.effort,
        serviceTierForTurn: this.settings.serviceTier ?? "default",
      });
      turnId ??= started.turn.id;
      if (threadId === this.parentId) this.activeTurnId = turnId;
      return await completed;
    } finally {
      off();
      if (threadId === this.parentId) this.activeTurnId = null;
    }
  }
}

const appServerInput = (input: CodexInput): any[] => [
  ...(input.text.trim()
    ? [{ type: "text", text: input.text, text_elements: [] }]
    : input.images.length
      ? [{ type: "text", text: "Examine the attached image.", text_elements: [] }]
      : []),
  ...input.images.map((image) => ({ type: "localImage", path: image.path })),
];

function appServerUsage(raw: any, model: Model): Usage {
  return codexUsage(
    {
      input_tokens: raw.inputTokens ?? 0,
      cached_input_tokens: raw.cachedInputTokens ?? 0,
      cache_write_input_tokens: raw.cacheWriteInputTokens ?? 0,
      output_tokens: raw.outputTokens ?? 0,
      reasoning_output_tokens: raw.reasoningOutputTokens ?? 0,
    },
    model,
  );
}

function appServerToolName(item: any): string | null {
  switch (item?.type) {
    case "commandExecution":
      return "Shell";
    case "fileChange":
      return "apply_patch";
    case "webSearch":
      return "web_search";
    case "mcpToolCall":
      return item.server === "tg" && item.tool === "send"
        ? null
        : `mcp__${item.server}__${item.tool}`;
    case "plan":
      return "update_plan";
    default:
      return null;
  }
}

export function createAgentSession(opts: AgentSessionOptions): AgentSession {
  return opts.provider === "codex" ? new CodexAgentSession(opts) : new ClaudeAgentSession(opts);
}
