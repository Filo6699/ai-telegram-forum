import { readFileSync } from "node:fs";
import { z } from "zod";
import { rejectLegacyPresets } from "./presets.ts";

const text = z.string().trim().min(1);
const positive = z.number().finite().positive();
const TRANSCRIPTION_URL = "https://api.groq.com/openai/v1";
const TRANSCRIPTION_MODEL = "whisper-large-v3-turbo";

/** Portable bot settings. Credentials and local DB/heartbeat paths stay in .env. */
export const settingsSchema = z.strictObject({
  LAUNCHER_THREAD_ID: z.union([z.literal("General"), z.number().int().positive()]).default("General"),
  DEFAULT_CWD: text.default("."),
  PROJECTS: z.record(z.string(), text).default({}),
  PROVIDER: z.enum(["claude", "codex", "openrouter"]).default("claude"),
  CLAUDE_MODEL: text.default("claude-opus-5-5"),
  CODEX_MODEL: text.default("gpt-5.6-sol"),
  // One block for every agent; each entry names its own provider.
  PRESETS: z.record(z.string(), z.unknown()).optional(),
  DEFAULT_PRESET: text.optional(),
  CODEX_EFFORT: z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  OPENROUTER_MODEL: text.default("openrouter/free"),
  OPENROUTER_HISTORY_PATH: text.default("./data/openrouter-sessions"),
  OPENROUTER_MAX_STEPS: positive.int().default(24),
  OPENROUTER_TURN_TIMEOUT_MINUTES: positive.default(30),
  OPENROUTER_MAX_TOOL_OUTPUT: positive.int().default(20_000),
  OPENROUTER_CONTEXT_WINDOW: positive.int().default(64_000),
  PERMISSION: z.enum(["auto", "bypass"]).default("auto"),
  ALLOWED_TOOLS: z.array(text).default(["Read", "Glob", "Grep", "Edit", "Write", "Bash"]),
  // Zero disables automatic topic deletion.
  DELETE_AFTER_HOURS: z.number().finite().nonnegative()
    .refine((hours) => Number.isFinite(hours * 3600_000), "must produce a finite duration")
    .default(168),
  SESSION_IDLE_MINUTES: positive.default(20),
  PERMISSION_TIMEOUT_MINUTES: positive.default(10),
  INBOX_PATH: text.default("./data/inbox"),
  // Voice and video notes become text through an OpenAI-compatible
  // transcription server. Off unless enabled; the key lives in .env.
  TRANSCRIPTION: z.strictObject({
    enabled: z.boolean().default(false),
    url: text.default(TRANSCRIPTION_URL),
    model: text.default(TRANSCRIPTION_MODEL),
    language: text.optional(),
  }).default({ enabled: false, url: TRANSCRIPTION_URL, model: TRANSCRIPTION_MODEL }),
});

export type Settings = z.infer<typeof settingsSchema>;

export function parseSettings(raw: unknown): Settings {
  rejectLegacyPresets(raw);
  const result = settingsSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid config.json: ${result.error.issues.map((issue) =>
      `${issue.path.join(".") || "settings"}: ${issue.message}`).join("; ")}`);
  }
  return result.data;
}

export function loadSettings(path: string): Settings {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return parseSettings({});
    throw new Error(`Cannot read config.json at ${path}`, { cause: error });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    throw new Error(`Invalid JSON in config.json at ${path}`);
  }
  return parseSettings(raw);
}
