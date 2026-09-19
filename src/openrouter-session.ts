import { randomUUID } from "node:crypto";
import type { Bot } from "grammy";
import type {
  AgentInput,
  AgentSession,
  AgentSessionHooks,
  AgentSettings,
  AgentSideResult,
} from "./agent-session.ts";
import { cfg } from "./config.ts";
import type { Usage } from "./claude.ts";
import { OpenRouterClient, OpenRouterError, openRouterCapabilityError, openRouterModelMetadata, openRouterUsage, type OpenRouterMessage, type OpenRouterResponse } from "./openrouter.ts";
import { OpenRouterHistory } from "./openrouter-history.ts";
import type { OpenRouterSettings } from "./openrouter-config.ts";
import { executeOpenRouterTool, OPENROUTER_TOOLS, toolInput, type OpenRouterToolContext } from "./openrouter-tools.ts";
import { TG_SEND_TOOL, type TgChannel } from "./tg-tools.ts";

const SYSTEM_PROMPT = `${
  `You are an agent working in a local repository and talking to a person over Telegram.\n\n` +
  `Use Read, Glob, Grep, Edit, Write, and Bash to inspect and change the working tree. ` +
  `Use ${TG_SEND_TOOL} for every complete message intended for the person. ` +
  `Your ordinary response text is only a fallback and is not delivered when a Telegram message was sent. ` +
  `Never send partial thoughts; batch related information into one finished message. ` +
  `Keep tool output and shell commands focused, and do not use tables in Telegram.\n\n`
}`;

interface LoopOptions {
  signal: AbortSignal;
  deliverTelegram: boolean;
  persist: boolean;
  onTool: (name: string, input: unknown) => void | Promise<void>;
  onModel?: (model: string) => void;
  onText?: (text: string) => void;
}

interface LoopResult {
  ok: boolean;
  failure: string | null;
  stopped: boolean;
  usage: Usage;
  answer: string;
  resolvedModel: string | null;
}

const zeroUsage = (): Usage => ({ inTokens: 0, outTokens: 0, costUsd: 0 });

function addUsage(a: Usage, b: ReturnType<typeof openRouterUsage>): Usage {
  return {
    inTokens: a.inTokens + b.inTokens,
    outTokens: a.outTokens + b.outTokens,
    costUsd: a.costUsd === null || b.costUsd === null ? null : a.costUsd + b.costUsd,
  };
}

function inputMessage(input: AgentInput): OpenRouterMessage {
  if (!input.images.length) return { role: "user", content: input.text };
  const content = [
    ...(input.text ? [{ type: "text" as const, text: input.text }] : []),
    ...input.images.map((image) => ({
      type: "image_url" as const,
      image_url: { url: `data:${image.mediaType};base64,${image.data}` },
    })),
  ];
  return { role: "user", content };
}

function textOf(message: OpenRouterMessage | undefined): string {
  if (!message?.content) return "";
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function cloneMessages(messages: OpenRouterMessage[]): OpenRouterMessage[] {
  return JSON.parse(JSON.stringify(messages)) as OpenRouterMessage[];
}

function roughTokens(message: OpenRouterMessage): number {
  const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "");
  return Math.ceil((content.length + JSON.stringify(message.tool_calls ?? []).length) / 4);
}

function messageSummary(message: OpenRouterMessage): string {
  const label = message.role === "tool" ? `tool ${message.name ?? "result"}` : message.role;
  return `${label}: ${typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "")}`;
}

/** Keep the original JSONL intact while sending a bounded, tool-pair-safe view. */
function contextMessages(messages: OpenRouterMessage[], limit: number, reserve: number): OpenRouterMessage[] {
  const budget = Math.max(1, Math.min(limit, limit - reserve));
  const system = messages.filter((message) => message.role === "system").slice(0, 1);
  const conversation = messages.filter((message) => message.role !== "system");
  const groups: OpenRouterMessage[][] = [];
  for (const message of conversation) {
    const current = groups.at(-1);
    if (!current || (message.role === "user" && current.some((item) => item.role !== "tool"))) {
      groups.push([message]);
    } else current.push(message);
  }

  let used = system.reduce((sum, message) => sum + roughTokens(message), 0);
  const kept: OpenRouterMessage[][] = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const group = groups[i]!;
    const size = group.reduce((sum, message) => sum + roughTokens(message), 0);
    if (kept.length && used + size > budget) break;
    kept.unshift(group);
    used += size;
  }
  const dropped = groups.slice(0, Math.max(0, groups.length - kept.length)).flat();
  const compacted: OpenRouterMessage[] = [...system];
  if (dropped.length) {
    const summary = dropped.map(messageSummary).join("\n").slice(0, 8_000);
    compacted.push({
      role: "system",
      content: `Earlier context was compacted to fit the model window. The full append-only history remains on disk.\n${summary}`,
    });
  }
  compacted.push(...kept.flat());
  return compacted;
}

function requestSettings(settings: AgentSettings): OpenRouterSettings {
  return settings.openrouter ?? { model: settings.model };
}

function effectiveReasoning(settings: AgentSettings, openrouter: OpenRouterSettings): unknown {
  if (!settings.effort) return openrouter.reasoning;
  if (openrouter.reasoning && typeof openrouter.reasoning === "object" && !Array.isArray(openrouter.reasoning)) {
    return { ...(openrouter.reasoning as Record<string, unknown>), effort: settings.effort };
  }
  return { effort: settings.effort };
}

function formatError(err: unknown): string {
  if (err instanceof OpenRouterError) return `❌ ${err.message}`;
  return `❌ OpenRouter request failed: ${String(err)}`;
}

function stoppedResult(
  usage: Usage,
  answer: string,
  resolvedModel: string | null,
): LoopResult {
  return { ok: false, failure: null, stopped: true, usage, answer, resolvedModel };
}

export class OpenRouterAgentSession implements AgentSession {
  private pending: AgentInput[] = [];
  private history: OpenRouterHistory | null = null;
  private running = false;
  private closed = false;
  private turnActive = false;
  private stopped = false;
  private timedOut = false;
  private abort: AbortController | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private startWaiter: { promise: Promise<void>; resolve: () => void } | null = null;
  private settings: AgentSettings;
  private readonly client: OpenRouterClient;

  constructor(private readonly opts: {
    bot: Bot;
    threadId: number;
    cwd: string;
    channel: TgChannel;
    hooks: AgentSessionHooks;
  } & AgentSettings) {
    this.settings = {
      sessionId: opts.sessionId,
      effort: opts.effort,
      model: opts.model,
      serviceTier: opts.serviceTier,
      openrouter: opts.openrouter,
    };
    this.client = new OpenRouterClient();
  }

  get controlQuery(): null {
    return null;
  }

  async send(input: AgentInput): Promise<void> {
    this.pending.push(input);
    if (this.running) return;
    let resolveStart!: () => void;
    const promise = new Promise<void>((resolve) => (resolveStart = resolve));
    this.startWaiter = { promise, resolve: resolveStart };
    void this.run();
    await promise;
  }

  async btw(input: AgentInput, onTool: (name: string) => void): Promise<AgentSideResult> {
    const history = await this.ensureHistory();
    const controller = new AbortController();
    const base = cloneMessages(history.ensureSystem(SYSTEM_PROMPT));
    const result = await this.runLoop(base, input, {
      signal: controller.signal,
      deliverTelegram: false,
      persist: false,
      onTool: (name) => onTool(name),
    });
    return {
      ok: result.ok,
      usage: result.usage,
      failure: result.failure,
      stopped: result.stopped,
      sent: 0,
      answer: result.answer,
      resolvedModel: result.resolvedModel,
    };
  }

  async interrupt(): Promise<boolean> {
    if (!this.turnActive || !this.abort) return false;
    this.stopped = true;
    this.abort.abort(new Error("OpenRouter turn stopped by the user"));
    return true;
  }

  async applySettings(settings: AgentSettings): Promise<void> {
    this.settings = { ...settings };
  }

  async suggestTitle(): Promise<string | null> {
    return null;
  }

  close(): void {
    this.closed = true;
    this.abort?.abort(new Error("OpenRouter session closed"));
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = null;
  }

  private async ensureHistory(): Promise<OpenRouterHistory> {
    if (!this.settings.sessionId) {
      const id = randomUUID();
      this.settings.sessionId = id;
      this.opts.hooks.session(id);
    }
    return (this.history ??= new OpenRouterHistory(this.settings.sessionId));
  }

  private async beginTurn(): Promise<void> {
    this.turnActive = true;
    this.stopped = false;
    this.timedOut = false;
    this.opts.channel.resetSent();
    this.abort = new AbortController();
    const controller = this.abort;
    this.timeout = setTimeout(() => {
      this.timedOut = true;
      controller.abort(new Error("OpenRouter turn timed out"));
    }, cfg.openrouterTurnTimeoutMs);
    try {
      await this.opts.hooks.beginTurn();
    } catch (err) {
      clearTimeout(this.timeout);
      this.timeout = null;
      this.abort = null;
      this.turnActive = false;
      throw err;
    }
  }

  private async finish(result: LoopResult): Promise<void> {
    const stopped = this.stopped || result.stopped;
    const failure = this.timedOut
      ? `⏱️ OpenRouter turn exceeded ${Math.round(cfg.openrouterTurnTimeoutMs / 60_000)} minutes`
      : result.failure;
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = null;
    this.abort = null;
    this.turnActive = false;
    await this.opts.hooks.endTurn({
      ok: result.ok && !failure,
      usage: result.usage,
      failure,
      stopped,
      sent: this.opts.channel.sent,
      resolvedModel: result.resolvedModel,
    });
  }

  private async run(): Promise<void> {
    this.running = true;
    try {
      while (!this.closed && this.pending.length) {
        const batch = this.pending.splice(0);
        const input: AgentInput = {
          text: batch.map((item) => item.text).filter(Boolean).join("\n\n"),
          images: batch.flatMap((item) => item.images),
        };
        try {
          await this.beginTurn();
        } finally {
          this.startWaiter?.resolve();
          this.startWaiter = null;
        }
        let result: LoopResult;
        try {
          const history = await this.ensureHistory();
          const messages = history.ensureSystem(SYSTEM_PROMPT);
          result = await this.runLoop(messages, input, {
            signal: this.abort!.signal,
            deliverTelegram: true,
            persist: true,
            onTool: (name, toolInputValue) => this.opts.hooks.tool(name, toolInputValue),
            onModel: (model) => this.opts.hooks.model?.(model),
            onText: (text) => this.opts.hooks.text(text),
          });
        } catch (err) {
          result = {
            ok: false,
            failure: this.stopped || this.abort?.signal.aborted ? null : formatError(err),
            stopped: this.stopped || Boolean(this.abort?.signal.aborted),
            usage: zeroUsage(),
            answer: "",
            resolvedModel: null,
          };
          if (result.failure) console.error(`[openrouter:${this.opts.threadId}] session failed:`, err);
        }
        await this.finish(result);
      }
    } finally {
      this.startWaiter?.resolve();
      this.startWaiter = null;
      this.running = false;
      this.abort = null;
      if (!this.closed && this.pending.length) void this.run();
    }
  }

  private async runLoop(
    initialMessages: OpenRouterMessage[],
    input: AgentInput,
    options: LoopOptions,
  ): Promise<LoopResult> {
    const history = options.persist ? await this.ensureHistory() : null;
    const messages = cloneMessages(initialMessages);
    const user = inputMessage(input);
    messages.push(user);
    if (history) history.append(user);

    const openrouter = requestSettings(this.settings);
    const requestedModel = openrouter.model ?? cfg.openrouterModel;
    let usage = zeroUsage();
    let answer = "";
    let resolvedModel: string | null = null;

    for (let step = 0; step < cfg.openrouterMaxSteps; step++) {
      if (options.signal.aborted) return stoppedResult(usage, answer, resolvedModel);
      const metadata = await openRouterModelMetadata(requestedModel);
      if (options.signal.aborted) return stoppedResult(usage, answer, resolvedModel);
      const capabilityError = openRouterCapabilityError(metadata, openrouter, input.images.length > 0);
      if (capabilityError) {
        return {
          ok: false,
          failure: `❌ ${capabilityError}`,
          stopped: false,
          usage,
          answer,
          resolvedModel,
        };
      }
      const reserve = openrouter.maxTokens ?? 4096;
      const body = {
        ...(openrouter.fallbacks?.length
          ? { models: [requestedModel, ...openrouter.fallbacks] }
          : { model: requestedModel }),
        messages: contextMessages(messages, metadata?.context_length ?? cfg.openrouterContextWindow, reserve),
        tools: OPENROUTER_TOOLS,
        ...(openrouter.temperature === undefined ? {} : { temperature: openrouter.temperature }),
        ...(openrouter.maxTokens === undefined
          ? {}
          : metadata?.supported_parameters?.includes("max_completion_tokens") &&
              !metadata.supported_parameters.includes("max_tokens")
            ? { max_completion_tokens: openrouter.maxTokens }
            : { max_tokens: openrouter.maxTokens }),
        ...(effectiveReasoning(this.settings, openrouter) === undefined
          ? {}
          : { reasoning: effectiveReasoning(this.settings, openrouter) }),
        ...(openrouter.provider === undefined ? {} : { provider: { ...openrouter.provider } }),
      };
      let response: OpenRouterResponse;
      try {
        response = await this.client.complete(body, options.signal);
      } catch (err) {
        if (options.signal.aborted) return stoppedResult(usage, answer, resolvedModel);
        return {
          ok: false,
          failure: formatError(err),
          stopped: false,
          usage,
          answer,
          resolvedModel,
        };
      }
      const responseUsage = openRouterUsage(response);
      usage = addUsage(usage, responseUsage);
      if (response.model) {
        resolvedModel = response.model;
        options.onModel?.(response.model);
      }
      const message = response.choices?.[0]?.message;
      if (!message) {
        return {
          ok: false,
          failure: "❌ OpenRouter returned no assistant message",
          stopped: false,
          usage,
          answer,
          resolvedModel,
        };
      }
      messages.push(message);
      if (history) history.append(message);
      const text = textOf(message);
      if (text.trim()) {
        answer = text;
        options.onText?.(text);
      }
      const calls = message.tool_calls ?? [];
      if (!calls.length) {
        return { ok: true, failure: null, stopped: false, usage, answer, resolvedModel };
      }

      for (const call of calls) {
        const name = call.function?.name ?? "unknown";
        const args = toolInput(call.function?.arguments ?? "{}");
        if (name !== TG_SEND_TOOL) await options.onTool(name, args);
        let result: string;
        try {
          const toolContext: OpenRouterToolContext = {
            bot: this.opts.bot,
            threadId: this.opts.threadId,
            cwd: this.opts.cwd,
            channel: this.opts.channel,
            signal: options.signal,
            deliverTelegram: options.deliverTelegram,
          };
          result = await executeOpenRouterTool(name, args, toolContext);
        } catch (err) {
          result = options.signal.aborted ? "Tool execution stopped before completion." : `Tool error: ${String(err)}`;
        }
        const toolMessage: OpenRouterMessage = {
          role: "tool",
          tool_call_id: call.id,
          content: result.slice(0, cfg.openrouterMaxToolOutput),
        };
        messages.push(toolMessage);
        if (history) history.append(toolMessage);
        if (options.signal.aborted) return stoppedResult(usage, answer, resolvedModel);
      }
    }
    return {
      ok: false,
      failure: `⚠️ OpenRouter reached the ${cfg.openrouterMaxSteps}-step tool limit`,
      stopped: false,
      usage,
      answer,
      resolvedModel,
    };
  }
}
