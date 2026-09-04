import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const codexCli = fileURLToPath(new URL("../node_modules/@openai/codex/bin/codex.js", import.meta.url));
const START_TIMEOUT_MS = 30_000;

export interface AppServerNotification {
  method: string;
  params?: any;
}

type NotificationListener = (message: AppServerNotification) => void;

/** A topic-owned Codex app-server connection, shared by its main and side turns. */
export class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve(value: any): void; reject(error: Error): void }
  >();
  private listeners = new Set<NotificationListener>();
  private starting: Promise<void> | null = null;
  private stderr = "";

  async start(): Promise<void> {
    if (this.child) return;
    if (this.starting) return this.starting;
    this.starting = this.open();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    await this.start();
    return this.writeRequest<T>(method, params);
  }

  onNotification(listener: NotificationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    const child = this.child;
    this.child = null;
    child?.kill();
    const error = new Error("Codex app-server closed");
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
    for (const listener of this.listeners) {
      listener({ method: "client/closed", params: { error } });
    }
    this.listeners.clear();
  }

  private async open(): Promise<void> {
    const child = spawn(process.execPath, [codexCli, "app-server", "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.stderr = "";
    const lines = createInterface({ input: child.stdout });

    child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + String(chunk)).slice(-4000);
    });
    child.on("error", (error) => this.fail(error));
    child.on("exit", (code) => {
      if (this.child !== child) return;
      this.fail(
        new Error(
          `Codex app-server exited ${code ?? "without a code"}: ${this.stderr.trim()}`,
        ),
      );
    });
    lines.on("line", (line) => this.receive(line));

    const timeout = setTimeout(
      () => this.fail(new Error(`Codex app-server initialization timed out`)),
      START_TIMEOUT_MS,
    );
    try {
      await this.writeRequest("initialize", {
        clientInfo: {
          name: "ai-telegram-forum",
          title: "Telegram broker",
          version: "0.1.0",
        },
        capabilities: { experimentalApi: true },
      });
      child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    } finally {
      clearTimeout(timeout);
    }
  }

  private writeRequest<T>(method: string, params?: unknown): Promise<T> {
    const child = this.child;
    if (!child) return Promise.reject(new Error("Codex app-server is not running"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.stdin.write(
        `${JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) })}\n`,
        (error) => {
          if (!error) return;
          this.pending.delete(id);
          reject(error);
        },
      );
    });
  }

  private receive(line: string): void {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (typeof message.id === "number" && !message.method) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) {
        waiter.reject(
          new Error(
            `${message.error.message ?? "Codex app-server request failed"}` +
              (message.error.data ? `: ${JSON.stringify(message.error.data)}` : ""),
          ),
        );
      } else {
        waiter.resolve(message.result);
      }
      return;
    }

    // The bridge runs Codex with approvalPolicy=never. Unexpected interactive
    // requests must still settle, otherwise one malformed turn waits forever.
    if (typeof message.id === "number" && message.method) {
      this.child?.stdin.write(
        `${JSON.stringify({
          id: message.id,
          error: { code: -32601, message: "Interactive requests are unavailable in Telegram" },
        })}\n`,
      );
      return;
    }

    if (typeof message.method === "string") {
      for (const listener of this.listeners) listener(message);
    }
  }

  private fail(cause: unknown): void {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    const child = this.child;
    this.child = null;
    child?.kill();
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
    for (const listener of this.listeners) {
      listener({ method: "client/closed", params: { error } });
    }
  }
}
