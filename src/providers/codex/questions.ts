import type { AgentInput } from "../../sessions/types.ts";
import type { QuestionPrompt } from "../../storage/db.ts";
import { TelegramQuestions, type QuestionContext, type UserQuestion } from "../../telegram/questions.ts";
import type { AppServerRequest, RequestId } from "./app-server-client.ts";

interface PendingRequest {
  request: AppServerRequest;
  context: QuestionContext;
  questions: UserQuestion[];
  answers: Record<string, { answers: string[] }>;
  timer: ReturnType<typeof setTimeout>;
  done: boolean;
}

/** Native request_user_input waits for a JSON-RPC result; async questions do not. */
export class CodexQuestions {
  private pending = new Map<RequestId, PendingRequest>();
  private publishing = new Set<string>();
  private answering = new Set<string>();
  private generation = 0;

  constructor(
    private prompts: TelegramQuestions,
    private timeoutMs: number,
    private deliver: (input: AgentInput) => Promise<void>,
  ) {}

  async publishAsync(sessionId: string, turnId: string, item: {
    id: string; questions: { title: string; options?: string[] | null }[];
  }): Promise<void> {
    const key = JSON.stringify([sessionId, turnId, item.id]);
    if (this.publishing.has(key)) return;
    this.publishing.add(key);
    const generation = this.generation;
    try {
      await this.prompts.ask({ sessionId, turnId, itemId: item.id, kind: "async" },
        item.questions.map((q, i) => ({ id: String(i), text: q.title, options: q.options ?? undefined })),
        () => this.generation === generation);
    } finally {
      this.publishing.delete(key);
    }
  }

  request(request: AppServerRequest): void {
    const p = request.params;
    const questions: UserQuestion[] = (p.questions ?? []).map((q: any) => ({
      id: q.id,
      text: q.question,
      options: q.options?.map((o: any) => `${o.label}${o.description ? ` — ${o.description}` : ""}`),
    }));
    const context: QuestionContext = {
      sessionId: p.threadId, turnId: p.turnId, itemId: p.itemId, kind: "rpc",
    };
    const group: PendingRequest = {
      request, context, questions, answers: Object.create(null), done: false,
      // Start before Telegram's round-trip: cancellation and timeout must also
      // settle a request whose prompt has not appeared yet.
      timer: setTimeout(() => { void this.finish(group, "⌛ Closed without an answer (timed out)."); }, this.timeoutMs),
    };
    this.pending.set(request.id, group);
    if (!questions.length) {
      void this.finish(group, "Closed without an answer.");
      return;
    }
    void this.prompts.ask(context, questions, () => !group.done).catch(async (err) => {
      console.warn("[codex] could not deliver input request:", String(err));
      await this.finish(group, "⚠️ Question delivery failed.");
      await this.prompts.notice("⚠️ Couldn't deliver a Codex question. The request was closed without assuming an answer.");
    });
  }

  async answer(messageId: number, sessionId: string | null, input: AgentInput): Promise<boolean> {
    const prompt = this.prompts.find(messageId);
    if (!prompt || prompt.session_id !== sessionId) return false;
    const key = JSON.stringify([prompt.session_id, prompt.turn_id, prompt.item_id, prompt.question_id]);
    if (this.answering.has(key)) return false;
    const group = prompt.kind === "rpc" ? [...this.pending.values()].find((g) =>
      g.context.sessionId === prompt.session_id && g.context.turnId === prompt.turn_id &&
      g.context.itemId === prompt.item_id && !g.done,
    ) : undefined;
    // Repeated replies are ordinary contextual follow-ups, not a second answer
    // on an already settled RPC.
    if (prompt.state === "answered" && !group) return false;
    this.answering.add(key);
    try {
      const answer = [input.text, ...input.images.map((image) => `[Attached image: ${image.path}]`)]
        .filter(Boolean).join("\n\n");
      if (group && prompt.state !== "closed") {
        group.answers[prompt.question_id] = { answers: [answer] };
        // Finish first so a slow Telegram edit never delays the model.
        if (group.questions.every((q) => Object.hasOwn(group.answers, q.id))) {
          if (!await this.finish(group, "Closed without an answer.")) throw new Error("Codex did not accept the RPC answer");
        }
        await this.prompts.mark(prompt, "answered", "✅ Answer received.");
      } else {
        if (prompt.kind === "rpc") {
          await this.prompts.notice("ℹ️ That Codex question is already closed. Sending your reply with the question as conversation context.");
        }
        await this.deliver({
          text: `Answer to Codex question:\n${prompt.question.split("\n").map((line) => `> ${line}`).join("\n")}\n\nUser answer:\n${input.text}`,
          images: input.images,
        });
        await this.prompts.mark(prompt, "answered", "✅ Answer delivered.");
      }
    } catch (err) {
      console.warn("[codex] delivering question answer failed:", String(err));
      await this.prompts.notice("⚠️ Couldn't deliver your answer to Codex. Please reply again to retry.");
    } finally {
      this.answering.delete(key);
    }
    return true;
  }

  resolved(requestId: RequestId): void {
    const group = this.pending.get(requestId);
    if (group) void this.finish(group, "Closed without an answer.", false);
  }

  cancelTurn(sessionId: string, turnId: string, respond = true): void {
    for (const group of this.pending.values()) {
      if (group.context.sessionId === sessionId && group.context.turnId === turnId) {
        void this.finish(group, "Closed without an answer.", respond);
      }
    }
  }

  close(): void {
    this.generation++;
    for (const group of this.pending.values()) void this.finish(group, "Closed (session ended).", false);
  }

  private async finish(group: PendingRequest, label: string, respond = true): Promise<boolean> {
    if (group.done) return true;
    group.done = true;
    this.pending.delete(group.request.id);
    clearTimeout(group.timer);
    const reply = respond ? group.request.respond({ answers: group.answers }).then(() => true).catch((err) => {
      console.warn("[codex] settling input request failed:", String(err));
      return false;
    }) : Promise.resolve(true);
    const seen = new Set<string>();
    const prompts = this.prompts.forItem(group.context).filter((p) => {
      if (p.state !== "open" || Object.hasOwn(group.answers, p.question_id) || seen.has(p.question_id)) return false;
      seen.add(p.question_id);
      return true;
    });
    const [accepted] = await Promise.all([reply, ...prompts.map((p: QuestionPrompt) => this.prompts.mark(p, "closed", label))]);
    return accepted;
  }
}
