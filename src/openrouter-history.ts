import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { OpenRouterMessage } from "./openrouter.ts";
import { cfg } from "./config.ts";

/** Append-only OpenRouter transcript. The topic database keeps only its id. */
export class OpenRouterHistory {
  readonly path: string;

  constructor(readonly sessionId: string, root = cfg.openrouterHistoryPath) {
    this.path = join(root, `${sessionId}.jsonl`);
  }

  messages(): OpenRouterMessage[] {
    if (!existsSync(this.path)) return [];
    const messages: OpenRouterMessage[] = [];
    try {
      for (const line of readFileSync(this.path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as { message?: OpenRouterMessage };
          if (event.message?.role) messages.push(event.message);
        } catch {
          console.warn(`[openrouter] ignoring malformed history line in ${this.path}`);
        }
      }
    } catch (err) {
      throw new Error(`couldn't read OpenRouter history: ${String(err)}`);
    }
    return messages;
  }

  append(message: OpenRouterMessage): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify({ message })}\n`, "utf8");
  }

  ensureSystem(content: string): OpenRouterMessage[] {
    const messages = this.messages();
    if (!messages.some((message) => message.role === "system")) {
      const system: OpenRouterMessage = { role: "system", content };
      this.append(system);
      messages.unshift(system);
    }
    return messages;
  }
}
