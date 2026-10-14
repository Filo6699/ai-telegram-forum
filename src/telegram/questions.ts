import type { Api } from "grammy";
import {
  getQuestionPrompt, itemQuestionPrompts, saveQuestionPrompt, setQuestionPromptState,
  type QuestionPrompt,
} from "../storage/db.ts";

export interface UserQuestion {
  id: string;
  text: string;
  options?: string[];
}

export interface QuestionContext {
  sessionId: string;
  turnId: string;
  itemId: string;
  kind: QuestionPrompt["kind"];
}

/** Each chunk is addressable, including unusually long questions. */
function chunks(text: string): string[] {
  const result: string[] = [];
  while (text.length > 3900) {
    let end = text.lastIndexOf("\n", 3900);
    if (end < 1950) end = 3900;
    if (/[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    result.push(text.slice(0, end));
    text = text.slice(end);
  }
  if (text.trim()) result.push(text);
  return result;
}

/** Presentation and durable reply bindings; protocol decisions belong to the provider. */
export class TelegramQuestions {
  constructor(private api: Api, private chatId: number, private threadId: number) {}

  find(messageId: number): QuestionPrompt | undefined {
    return getQuestionPrompt(this.chatId, this.threadId, messageId);
  }

  async ask(context: QuestionContext, questions: UserQuestion[], alive: () => boolean = () => true): Promise<void> {
    for (const q of questions) {
      const existing = this.forItem(context).some((p) => p.question_id === q.id);
      if (existing) continue;
      const question = [q.text, ...(q.options ?? []).map((option, i) => `${i + 1}. ${option}`)].join("\n");
      for (const part of chunks(question)) {
        if (!alive()) return;
        const display = `${part}\n\n↩️ Reply to this message to answer.`;
        const sent = await this.api.sendMessage(this.chatId, display, {
          message_thread_id: this.threadId,
        });
        const prompt: QuestionPrompt = {
          chat_id: this.chatId, thread_id: this.threadId, message_id: sent.message_id,
          session_id: context.sessionId, turn_id: context.turnId, item_id: context.itemId,
          question_id: q.id, kind: context.kind, question, display_text: part, state: "open",
        };
        saveQuestionPrompt(prompt);
        // Cancellation can win while Telegram is accepting the message.
        if (!alive()) await this.mark(prompt, "closed", "closed without an answer");
      }
    }
  }

  forItem(context: QuestionContext): QuestionPrompt[] {
    return itemQuestionPrompts(this.chatId, this.threadId, context.sessionId, context.turnId, context.itemId);
  }

  async mark(prompt: QuestionPrompt, state: QuestionPrompt["state"], label: string): Promise<void> {
    setQuestionPromptState(prompt, state);
    const aliases = itemQuestionPrompts(this.chatId, this.threadId, prompt.session_id, prompt.turn_id, prompt.item_id)
      .filter((p) => p.question_id === prompt.question_id);
    await Promise.all(aliases.map(async (p) => {
      try {
        await this.api.editMessageText(this.chatId, p.message_id, `${p.display_text}\n\n${label}`);
      } catch (err) {
        console.warn(`[questions:${this.threadId}] editing prompt failed:`, String(err));
      }
    }));
  }

  async notice(text: string): Promise<void> {
    try {
      await this.api.sendMessage(this.chatId, text, { message_thread_id: this.threadId, disable_notification: true });
    } catch (err) {
      console.warn(`[questions:${this.threadId}] notice failed:`, String(err));
    }
  }
}
