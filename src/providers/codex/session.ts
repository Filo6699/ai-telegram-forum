import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { codexAppThreadParams, codexSideBoundaryItem, codexSideForkParams, readCodexUsage, type CodexInput } from "./options.ts";
import { CodexAppServerClient, type AppServerNotification } from "./app-server-client.ts";
import { cfg } from "../../config/env.ts";
import { recordCodexTurnTier } from "../../storage/db.ts";
import { PENDING_TITLE_MARK } from "../../sessions/cwd.ts";
import type { Model } from "../../config/model.ts";
import { tgSendDelivered, type TgSendArgs } from "../../telegram/tg-tools.ts";
import type { AgentInput, AgentSession, AgentSessionOptions, AgentSettings, AgentSideResult, AgentTurnResult } from "../../sessions/types.ts";
import { zeroUsage, type Usage } from "../../sessions/usage.ts";
import { clearPermissions } from "../../telegram/permission.ts";

// Keep the app-server adapter compatible with the earlier token-only helper as
// well as the newer model-priced helper while that accounting work is local.
const codexUsage = readCodexUsage as unknown as (usage: any, model?: Model) => Usage;

export class CodexAgentSession implements AgentSession {
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
      openrouter: opts.openrouter,
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
          onTool: (name, input) => this.opts.hooks.tool(name, input),
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
    options: { onTool(name: string, input?: unknown): void | Promise<void>; deliverTelegram: boolean },
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
        if (name) deliveries.push(Promise.resolve(options.onTool(name, params.item)).catch((err) => {
          console.warn("[toolcalls] delivery failed:", String(err));
        }));
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
      if (options.deliverTelegram) {
        try {
          recordCodexTurnTier(threadId, turnId, this.settings.serviceTier ?? "default");
        } catch (err) {
          console.warn(`[codex:${this.opts.threadId}] recording turn tier failed:`, String(err));
        }
      }
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
    case "dynamicToolCall":
      return item.tool ?? "dynamic_tool";
    case "collabAgentToolCall":
      return item.tool ?? "agent";
    case "imageGeneration":
      return "image_generation";
    case "imageView":
      return "view_image";
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
