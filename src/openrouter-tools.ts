import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { Bot } from "grammy";
import { cfg } from "./config.ts";
import { authorizeTool } from "./permission.ts";
import { TG_SEND_TOOL, tgSendDelivered, type TgChannel, type TgSendArgs } from "./tg-tools.ts";
import type { OpenRouterTool } from "./openrouter.ts";

const READ_TOOL = "Read";
const GLOB_TOOL = "Glob";
const GREP_TOOL = "Grep";
const EDIT_TOOL = "Edit";
const WRITE_TOOL = "Write";
const BASH_TOOL = "Bash";

const stringProperty = (description: string) => ({ type: "string", description });

export const OPENROUTER_TOOLS: OpenRouterTool[] = [
  {
    type: "function",
    function: {
      name: READ_TOOL,
      description: "Read a text file in the working directory.",
      parameters: {
        type: "object",
        properties: {
          file_path: stringProperty("Absolute or working-directory-relative file path."),
          offset: { type: "integer", minimum: 1, description: "1-based line to start from." },
          limit: { type: "integer", minimum: 1, description: "Maximum number of lines." },
        },
        required: ["file_path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: GLOB_TOOL,
      description: "Find files matching a glob pattern.",
      parameters: {
        type: "object",
        properties: {
          pattern: stringProperty("Glob such as **/*.ts or src/**/*.test.ts."),
          path: stringProperty("Directory to search, relative to the working directory."),
        },
        required: ["pattern"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: GREP_TOOL,
      description: "Search text in files with a regular expression.",
      parameters: {
        type: "object",
        properties: {
          pattern: stringProperty("Regular expression to search for."),
          path: stringProperty("File or directory to search."),
          glob: stringProperty("Optional file glob, such as *.ts."),
          case_insensitive: { type: "boolean" },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: EDIT_TOOL,
      description: "Replace text in a file. The old text must match exactly.",
      parameters: {
        type: "object",
        properties: {
          file_path: stringProperty("Absolute or working-directory-relative file path."),
          old_string: stringProperty("Exact text to replace."),
          new_string: stringProperty("Replacement text."),
          replace_all: { type: "boolean", description: "Replace every match instead of the first." },
        },
        required: ["file_path", "old_string", "new_string"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: WRITE_TOOL,
      description: "Write complete text content to a file, creating parent directories.",
      parameters: {
        type: "object",
        properties: {
          file_path: stringProperty("Absolute or working-directory-relative file path."),
          content: stringProperty("Complete file content."),
        },
        required: ["file_path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: BASH_TOOL,
      description: "Run a shell command in the working directory.",
      parameters: {
        type: "object",
        properties: { command: stringProperty("Shell command to run.") },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: TG_SEND_TOOL,
      description: "Send one complete message to the person on Telegram, optionally attaching local files.",
      parameters: {
        type: "object",
        properties: {
          text: stringProperty("Finished Markdown message, without tables."),
          files: { type: "array", items: { type: "string" }, description: "Local files to attach." },
        },
        additionalProperties: false,
      },
    },
  },
];

export interface OpenRouterToolContext {
  bot: Bot;
  threadId: number;
  cwd: string;
  channel: TgChannel;
  signal: AbortSignal;
  deliverTelegram: boolean;
}

const asRecord = (input: unknown): Record<string, unknown> =>
  input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};

function pathInCwd(cwd: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("file_path is required");
  return isAbsolute(value) ? value : resolve(cwd, value);
}

function bounded(value: string, limit = cfg.openrouterMaxToolOutput): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit))}\n… (tool output truncated at ${limit} characters)`;
}

async function readTool(args: Record<string, unknown>, cwd: string): Promise<string> {
  const path = pathInCwd(cwd, args.file_path);
  const text = await readFile(path, "utf8");
  const lines = text.split("\n");
  const offset = typeof args.offset === "number" ? Math.max(1, Math.floor(args.offset)) : 1;
  const limit = typeof args.limit === "number" ? Math.max(1, Math.floor(args.limit)) : lines.length;
  return bounded(lines.slice(offset - 1, offset - 1 + limit).join("\n"));
}

function globRegex(pattern: string): RegExp {
  let source = "^";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === "*" && pattern[i + 1] === "*" && pattern[i + 2] === "/") {
      source += "(?:.*/)?";
      i += 2;
    } else if (char === "*" && pattern[i + 1] === "*") {
      source += ".*";
      i++;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${source}$`);
}

async function walk(root: string, dir = "", found: string[] = []): Promise<string[]> {
  if (found.length >= 5000) return found;
  let entries;
  try {
    entries = await readdir(resolve(root, dir), { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const child = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await walk(root, child, found);
    else found.push(child);
    if (found.length >= 5000) break;
  }
  return found;
}

async function globTool(args: Record<string, unknown>, cwd: string): Promise<string> {
  const pattern = typeof args.pattern === "string" ? args.pattern : "";
  if (!pattern) throw new Error("pattern is required");
  const root = args.path === undefined ? cwd : pathInCwd(cwd, args.path);
  const matcher = globRegex(pattern.replaceAll("\\", "/").replace(/^\.\//, ""));
  const files = await walk(root);
  const matched = files.filter((file) => matcher.test(file));
  return bounded(matched.join("\n"));
}

function execFileText(
  file: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveResult, reject) => {
    const child = execFile(file, args, { cwd, signal, maxBuffer: cfg.openrouterMaxToolOutput * 2 });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (data: Buffer) => (stdout += data.toString()));
    child.stderr?.on("data", (data: Buffer) => (stderr += data.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolveResult({ code: code ?? 1, stdout, stderr }));
  });
}

async function grepTool(args: Record<string, unknown>, ctx: OpenRouterToolContext): Promise<string> {
  const pattern = typeof args.pattern === "string" ? args.pattern : "";
  if (!pattern) throw new Error("pattern is required");
  const searchPath = typeof args.path === "string" && args.path ? args.path : ".";
  const commandArgs = ["--line-number", "--no-heading", "--color", "never"];
  if (args.case_insensitive === true) commandArgs.push("--ignore-case");
  if (typeof args.glob === "string" && args.glob) commandArgs.push("--glob", args.glob);
  commandArgs.push(pattern, searchPath);
  const result = await execFileText("rg", commandArgs, ctx.cwd, ctx.signal);
  if (result.code > 1) throw new Error(result.stderr.trim() || `rg exited with ${result.code}`);
  return bounded(result.stdout || result.stderr);
}

function commandText(result: { code: number; stdout: string; stderr: string }): string {
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  return bounded(`exit code: ${result.code}\n${output}`.trim());
}

async function bashTool(args: Record<string, unknown>, ctx: OpenRouterToolContext): Promise<string> {
  const command = typeof args.command === "string" ? args.command : "";
  if (!command) throw new Error("command is required");
  const result = await execFileText("/bin/sh", ["-c", command], ctx.cwd, ctx.signal);
  return commandText(result);
}

async function editTool(args: Record<string, unknown>, cwd: string): Promise<string> {
  const path = pathInCwd(cwd, args.file_path);
  const oldString = typeof args.old_string === "string" ? args.old_string : "";
  const newString = typeof args.new_string === "string" ? args.new_string : "";
  if (!oldString) throw new Error("old_string is required");
  const text = await readFile(path, "utf8");
  const matches = text.split(oldString).length - 1;
  if (!matches) throw new Error("old_string was not found in the file");
  const output = args.replace_all === true ? text.split(oldString).join(newString) : text.replace(oldString, newString);
  await writeFile(path, output, "utf8");
  return `edited ${path} (${args.replace_all === true ? matches : 1} replacement${matches === 1 ? "" : "s"})`;
}

async function writeTool(args: Record<string, unknown>, cwd: string): Promise<string> {
  const path = pathInCwd(cwd, args.file_path);
  if (typeof args.content !== "string") throw new Error("content is required");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, args.content, "utf8");
  return `wrote ${path} (${args.content.length} characters)`;
}

/** Execute one model-suggested call. The caller records it in history once. */
export async function executeOpenRouterTool(
  name: string,
  rawInput: unknown,
  ctx: OpenRouterToolContext,
): Promise<string> {
  const args = asRecord(rawInput);
  if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error("OpenRouter turn stopped");

  if (name === TG_SEND_TOOL && !ctx.deliverTelegram) {
    return "Telegram delivery is disabled for a side question; put the answer in your final response.";
  }

  const allowed = await authorizeTool(ctx.bot, ctx.threadId, name, args);
  if (!allowed) return "Tool call denied by the user over Telegram.";

  switch (name) {
    case READ_TOOL:
      return await readTool(args, ctx.cwd);
    case GLOB_TOOL:
      return await globTool(args, ctx.cwd);
    case GREP_TOOL:
      return await grepTool(args, ctx);
    case EDIT_TOOL:
      return await editTool(args, ctx.cwd);
    case WRITE_TOOL:
      return await writeTool(args, ctx.cwd);
    case BASH_TOOL:
      return await bashTool(args, ctx);
    case TG_SEND_TOOL: {
      const result = await ctx.channel.send(args as TgSendArgs);
      return tgSendDelivered(result)
        ? result.content[0]?.text ?? "sent"
        : result.content[0]?.text ?? "Telegram delivery failed";
    }
    default:
      return `Unknown tool: ${name}`;
  }
}

export function toolInput(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string") return {};
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return {};
  }
}
