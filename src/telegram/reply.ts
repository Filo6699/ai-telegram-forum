import type { AgentInput } from "../sessions/types.ts";

/** Quote the actual parent; never infer a question from the latest message. */
export function replyContext(input: AgentInput): string {
  if (!input.replyTo) return input.text;
  const quote = input.replyTo.text || `[Telegram message ${input.replyTo.messageId}]`;
  return `Reply to Telegram message ${input.replyTo.messageId}:\n${quote.split("\n").map((line) => `> ${line}`).join("\n")}\n\nUser reply:\n${input.text}`;
}
