import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

function arg(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`missing --${name}`);
  return value;
}

const threadId = Number(arg("thread"));
if (!Number.isFinite(threadId)) throw new Error("--thread must be a number");
const cwd = arg("cwd");

const server = new McpServer({ name: "tg", version: "1.0.0" });

// Codex inherits MCP servers into subagents. This process must therefore not
// have Telegram side effects: the owning broker delivers top-level calls from
// the parent event stream. Child calls receive an acknowledgement only.
const accepted = { content: [{ type: "text" as const, text: "accepted" }] };

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
  async () => accepted,
);

await server.connect(new StdioServerTransport());
