import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Api } from "grammy";
import { z } from "zod";
import { cfg } from "./config.ts";
import { TopicRenderer } from "./render.ts";
import { runTgSend } from "./tg-tools.ts";

function arg(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`missing --${name}`);
  return value;
}

const threadId = Number(arg("thread"));
if (!Number.isFinite(threadId)) throw new Error("--thread must be a number");
const cwd = arg("cwd");

const out = new TopicRenderer(new Api(cfg.token), cfg.chatId, threadId);
const server = new McpServer({ name: "tg", version: "1.0.0" });

server.registerTool(
  "send",
  {
    description:
      "Send a finished message to the person on Telegram, optionally with local files. Markdown is supported except tables.",
    inputSchema: {
      text: z.string().default("").describe("Message body. Markdown, no tables; keep it short."),
      files: z
        .array(z.string())
        .optional()
        .describe("Local paths to attach, relative to the working directory or absolute."),
    },
  },
  (args) => runTgSend(out, cwd, args),
);

await server.connect(new StdioServerTransport());
