import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const codexCli = fileURLToPath(new URL("../node_modules/@openai/codex/bin/codex.js", import.meta.url));
const ASK_TIMEOUT_MS = 60_000;

/** Make one request through Codex's official local app-server protocol. */
export function codexRequest<T>(method: string, params?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [codexCli, "app-server", "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = createInterface({ input: child.stdout });
    let stderr = "";
    let settled = false;

    const finish = (error?: unknown, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.kill();
      if (error) reject(error);
      else resolve(value as T);
    };
    const timer = setTimeout(
      () => finish(new Error(`Codex app-server timed out after ${ASK_TIMEOUT_MS}ms`)),
      ASK_TIMEOUT_MS,
    );

    child.stderr.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-4000);
    });
    child.on("error", finish);
    child.on("exit", (code) => {
      if (!settled) {
        finish(new Error(`Codex app-server exited ${code ?? "without a code"}: ${stderr.trim()}`));
      }
    });
    lines.on("line", (line) => {
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id === 1 && message.result) {
        child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
        child.stdin.write(`${JSON.stringify({ id: 2, method, ...(params ? { params } : {}) })}\n`);
      } else if (message.id === 1 && message.error) {
        finish(new Error(message.error.message ?? "Codex app-server initialization failed"));
      } else if (message.id === 2 && message.error) {
        finish(new Error(message.error.message ?? `${method} failed`));
      } else if (message.id === 2) {
        finish(undefined, message.result as T);
      }
    });

    child.stdin.write(
      `${JSON.stringify({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: {
            name: "ai-telegram-forum",
            title: "Telegram broker",
            version: "0.1.0",
          },
          capabilities: { experimentalApi: true },
        },
      })}\n`,
    );
  });
}
