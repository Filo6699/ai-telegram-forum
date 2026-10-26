import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { codexAppThreadParams, codexSideBoundaryItem, codexSideForkParams, readCodexUsage, type CodexInput } from "./options.ts";
import { AppServerError, CodexAppServerClient, type AppServerNotification } from "./app-server-client.ts";
import { CodexQuestions } from "./questions.ts";
import { TelegramQuestions } from "../../telegram/questions.ts";
import { cfg } from "../../config/env.ts";
import { getTopic, recordCodexTurnTier } from "../../storage/db.ts";
import { PENDING_TITLE_MARK } from "../../sessions/cwd.ts";
import { TG_ATTACHMENT_FAILURE_GUIDANCE, tgSendDelivered, type TgSendArgs } from "../../telegram/tg-tools.ts";
import type { AgentInput, AgentSession, AgentSessionOptions, AgentSettings, AgentSideResult, AgentTurnResult } from "../../sessions/types.ts";
import { zeroUsage, type Usage } from "../../sessions/usage.ts";
import { clearPermissions } from "../../telegram/permission.ts";
import { CodexResponseUsage, type CodexTokenUsage } from "./token-usage.ts";
import { isCapacityFailure } from "../../sessions/capacity-retry.ts";
import { isQuotaFailure, QUOTA_CONTINUATION } from "../../sessions/quota-retry.ts";

export class CodexAgentSession implements AgentSession {
  private pending: CodexInput[] = [];
  private questions: CodexQuestions;
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
  private capacityInput: CodexInput | null = null;
  private quotaInput: CodexInput | null = null;
  private inputVersion = 0;

  constructor(private opts: AgentSessionOptions, private server = new CodexAppServerClient()) {
    this.settings = {
      sessionId: opts.sessionId,
      effort: opts.effort,
      model: opts.model,
      serviceTier: opts.serviceTier,
      openrouter: opts.openrouter,
    };
    this.questions = new CodexQuestions(
      new TelegramQuestions(opts.bot.api, cfg.chatId, opts.threadId),
      cfg.permissionTimeoutMs,
      (input) => this.deliverAnswer(input),
    );
  }

  get controlQuery(): Query | null {
    return null;
  }

  async send(input: AgentInput): Promise<void> {
    this.capacityInput = null;
    this.quotaInput = null;
    this.inputVersion++;
    this.pending.push(input);
    if (!this.running) void this.run();
  }

  async retryCapacity(): Promise<boolean> {
    if (this.closed || !this.capacityInput || this.turnActive || this.pending.length) return false;
    const input = this.capacityInput;
    await this.send(input);
    return true;
  }

  async retryQuota(): Promise<boolean> {
    if (this.closed || !this.quotaInput || this.turnActive || this.pending.length) return false;
    const input = this.quotaInput;
    await this.send(input);
    return true;
  }

  async answerQuestion(messageId: number, input: AgentInput): Promise<boolean> {
    return this.questions.answer(messageId, this.settings.sessionId, input);
  }

  private async deliverAnswer(input: AgentInput): Promise<void> {
    const threadId = this.parentId;
    const turnId = this.activeTurnId;
    if (threadId && turnId) {
      try {
        await this.server.request("turn/steer", {
          threadId, expectedTurnId: turnId, input: appServerInput(input),
        });
        return;
      } catch (err) {
        // Retry as queued input only for an explicit turn-transition rejection.
        // A broken transport may have accepted the input: do not duplicate it.
        if (!(err instanceof AppServerError) || !/no active turn|turn.*(mismatch|not.*active)|expected.*turn/i.test(err.message)) throw err;
      }
    }
    await this.send(input);
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
    if (!this.turnActive && (this.capacityInput || this.quotaInput)) {
      this.capacityInput = null;
      this.quotaInput = null;
      this.inputVersion++;
      return true;
    }
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
    this.capacityInput = null;
    this.quotaInput = null;
    this.questions.close();
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
        sourceSessionId: getTopic(this.opts.threadId)?.source_session_id,
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

  private async finish(ok: boolean, usage: Usage, recoveringCapacity = false): Promise<void> {
    const result: AgentTurnResult = {
      ok,
      usage,
      failure: this.failure,
      stopped: this.stopped,
      sent: this.sent,
      recoveringCapacity,
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
        let input: CodexInput = {
          text: batch.map((message) => message.text).filter(Boolean).join("\n\n"),
          images: batch.flatMap((message) => message.images),
        };
        const version = this.inputVersion;
        let retries = 0;
        for (;;) {
          await this.beginTurn();
          let result: AgentSideResult;
          let accepted = false;
          try {
            const parentId = await this.ensureThread();
            result = await this.runAppTurn(parentId, input, {
              onTool: (name, input) => this.opts.hooks.tool(name, input),
              deliverTelegram: true,
              onAccepted: () => { accepted = true; },
            });
          } catch (err) {
            // Only an explicit capacity/quota rejection is safe to retry. A lost
            // connection may already have accepted the request.
            if (!isCapacityFailure(String(err)) && !isQuotaFailure(String(err))) throw err;
            result = { ok: false, failure: `⚠️ ${String(err)}`, stopped: this.stopped,
              sent: 0, usage: zeroUsage(), answer: "" };
          }
          this.failure = result.failure;
          this.sent = result.sent;
          this.stopped = this.stopped || result.stopped;
          const recover = !result.ok && !this.closed && !this.stopped && isCapacityFailure(result.failure)
            && Boolean(this.opts.hooks.recoverCapacity);
          // Accepted turns already retain the user's text and attachments.
          // Continue that task instead of replaying its input or its tools.
          if (accepted) input = { text: "Continue the previous request after the model capacity error. Check the existing progress before continuing; do not repeat completed actions.", images: [] };
          this.capacityInput = recover && version === this.inputVersion ? input : null;
          this.quotaInput = !result.ok && !this.closed && !this.stopped && isQuotaFailure(result.failure)
            && version === this.inputVersion ? (accepted ? { text: QUOTA_CONTINUATION, images: [] } : input) : null;
          await this.finish(result.ok, result.usage, recover);
          if (!recover || this.closed) break;
          const retry = await this.opts.hooks.recoverCapacity!(result.failure!, retries, version === this.inputVersion);
          if (!retry || this.closed || version !== this.inputVersion) break;
          retries++;
          this.capacityInput = null;
        }
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
    options: { onTool(name: string, input?: unknown): void | Promise<void>; deliverTelegram: boolean; onAccepted?(): void },
  ): Promise<AgentSideResult> {
    let turnId: string | null = null;
    let answer = "";
    let hasFinalAnswer = false;
    let turnCompleted = false;
    let usage = zeroUsage();
    const tokens = new CodexResponseUsage();
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
        this.questions.close();
        this.parentId = null;
        this.activeTurnId = null;
        reject(event.params.error);
        return;
      }
      const params = event.params;
      if (!belongs(params)) return;

      if (event.method === "serverRequest/resolved") {
        this.questions.resolved(params.requestId);
      } else if (event.method === "turn/started") {
        turnId ??= params.turn.id;
        if (threadId === this.parentId) this.activeTurnId = turnId;
      } else if (event.method === "item/started") {
        const name = appServerToolName(params.item);
        if (name) deliveries.push(Promise.resolve(options.onTool(name, params.item)).catch((err) => {
          console.warn("[toolcalls] delivery failed:", String(err));
        }));
      } else if (event.method === "item/completed") {
        const item = params.item;
        if (item.type === "agentMessage" && item.delivery === "async" && item.questions?.length) {
          // Async questions use final_answer as their phase while the turn keeps
          // working. They must never enter the buffered final-answer fallback.
          if (options.deliverTelegram) deliveries.push(
            this.questions.publishAsync(threadId, params.turnId ?? turnId!, item).catch((err) => {
              failure ??= `⚠️ Couldn't deliver Codex question: ${String(err)}`;
              console.warn("[codex] async question delivery failed:", String(err));
            }),
          );
        } else if (item.type === "agentMessage" && item.text?.trim()) {
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
          const args = item.arguments as TgSendArgs;
          deliveries.push((async () => {
            let feedback: string | null = null;
            try {
              const result = await this.opts.channel.send(args);
              if (tgSendDelivered(result)) sent++;
              else failure ??= `⚠️ Telegram delivery failed: ${result.content[0]?.text ?? "unknown error"}`;
              if ("isError" in result) feedback = result.content[0]?.text ?? "Telegram delivery failed";
            } catch (err) {
              feedback = `Telegram delivery failed: ${String(err)}`;
              failure ??= `⚠️ ${feedback}`;
              feedback += `\n${TG_ATTACHMENT_FAILURE_GUIDANCE}`;
            }
            // The inherited MCP server only acknowledges calls; the broker
            // owns the upload. Return failures to the parent agent as input,
            // even when the caption or some of the files reached Telegram.
            if (feedback && args.files?.length && !this.closed && !this.stopped) {
              try {
                await this.deliverAnswer({
                  text: `[Telegram attachment delivery feedback for send call ${item.id}]\n${feedback}`,
                  images: [],
                });
              } catch (err) {
                console.warn("[codex] attachment failure feedback failed:", String(err));
                failure ??= `⚠️ Couldn't notify the agent about failed attachments: ${String(err)}`;
              }
            }
          })());
        }
      } else if (event.method === "thread/tokenUsage/updated") {
        const last = params.tokenUsage?.last;
        if (last && tokens.add(
          appServerTokens(last),
          params.tokenUsage.total ? appServerTokens(params.tokenUsage.total) : undefined,
        )) {
          usage = readCodexUsage({
            input_tokens: tokens.inputTokens,
            output_tokens: tokens.outputTokens,
          });
        }
      } else if (event.method === "error" && !params.willRetry) {
        failure ??= `⚠️ ${params.error?.message ?? "Codex turn failed"}`;
      } else if (event.method === "turn/completed") {
        turnCompleted = true;
        if (threadId === this.parentId) this.activeTurnId = null;
        this.questions.cancelTurn(threadId, params.turn.id);
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
    const offRequest = this.server.onRequest((request) => {
      if (request.method !== "item/tool/requestUserInput" || !belongs(request.params)) return false;
      if (options.deliverTelegram) this.questions.request(request);
      else void request.respond({ answers: {} }).catch((err) => {
        console.warn("[codex] closing side question failed:", String(err));
      });
      return true;
    });
    try {
      const started = await this.server.request<{ turn: { id: string } }>("turn/start", {
        threadId,
        input: appServerInput(input),
        model: this.settings.model ?? cfg.codexModel,
        effort: this.settings.effort,
        serviceTierForTurn: this.settings.serviceTier ?? "default",
      });
      turnId ??= started.turn.id;
      options.onAccepted?.();
      if (options.deliverTelegram) {
        try {
          recordCodexTurnTier(threadId, turnId, this.settings.serviceTier ?? "default");
        } catch (err) {
          console.warn(`[codex:${this.opts.threadId}] recording turn tier failed:`, String(err));
        }
      }
      if (!turnCompleted && threadId === this.parentId) this.activeTurnId = turnId;
      return await completed;
    } finally {
      off();
      offRequest();
      if (turnId) this.questions.cancelTurn(threadId, turnId);
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

function appServerTokens(raw: any): CodexTokenUsage {
  return {
    input_tokens: raw.inputTokens ?? 0,
    cached_input_tokens: raw.cachedInputTokens ?? 0,
    output_tokens: raw.outputTokens ?? 0,
    total_tokens: raw.totalTokens,
  };
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
