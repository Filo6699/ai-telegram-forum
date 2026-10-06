import { parse as parseEnv } from "dotenv";
import { buildConfig } from "./runtime.ts";
import { parseSettings, settingsSchema } from "./settings.ts";

export const LOCAL_ENV_KEYS = [
  "BOT_TOKEN", "FORUM_CHAT_ID", "ALLOWED_USER_ID", "OPENROUTER_API_KEY", "DB_PATH", "PID_PATH",
] as const;

const JSON_KEYS = new Set(["PROJECTS", "CODEX_PRESETS", "OPENROUTER_PRESETS"]);
const NUMBER_KEYS = new Set([
  "OPENROUTER_MAX_STEPS", "OPENROUTER_TURN_TIMEOUT_MINUTES", "OPENROUTER_MAX_TOOL_OUTPUT",
  "OPENROUTER_CONTEXT_WINDOW", "DELETE_AFTER_HOURS", "SESSION_IDLE_MINUTES", "PERMISSION_TIMEOUT_MINUTES",
]);

/** Split an existing .env without putting credentials in the portable settings. */
export function splitLegacyEnv(source: string) {
  const env = parseEnv(source);
  const raw: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(env)) {
    if ((LOCAL_ENV_KEYS as readonly string[]).includes(key)) continue;
    const setting = key === "MODEL" ? "CLAUDE_MODEL" : key;
    if (!(setting in settingsSchema.shape)) {
      throw new Error(`Cannot migrate unknown env var ${key}; move it out of .env first`);
    }
    if (key === "MODEL" && env.CLAUDE_MODEL !== undefined) continue;
    if (JSON_KEYS.has(setting)) {
      try {
        raw[setting] = JSON.parse(value);
      } catch {
        throw new Error(`Cannot migrate ${key}: invalid JSON`);
      }
    } else if (NUMBER_KEYS.has(setting)) {
      raw[setting] = Number(value);
    } else if (setting === "LAUNCHER_THREAD_ID") {
      raw[setting] = !value.trim() || value.trim().toLowerCase() === "general" ? "General" : Number(value);
    } else if (setting === "ALLOWED_TOOLS") {
      raw[setting] = value.split(",").map((tool) => tool.trim()).filter(Boolean);
    } else {
      raw[setting] = value;
    }
  }
  const settings = parseSettings(raw);
  buildConfig(settings, env); // Validate presets and required credentials before writing either file.

  // Match dotenv's assignment grammar so quoted multiline values and paths are
  // preserved verbatim, including backslashes. Never re-encode secrets as JSON.
  const assignments = /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/mg;
  const retained = new Map<string, string>();
  for (const match of source.replace(/\r\n?/g, "\n").matchAll(assignments)) {
    if ((LOCAL_ENV_KEYS as readonly string[]).includes(match[1]!)) {
      retained.set(match[1]!, match[0].trim());
    }
  }
  const defaults: Record<string, string> = {
    OPENROUTER_API_KEY: "", DB_PATH: "./data/state.db", PID_PATH: "./data/bot.pid",
  };
  const envText = "# Credentials and machine-specific paths. Portable settings are in config.json.\n" +
    LOCAL_ENV_KEYS.map((key) => retained.get(key) ?? `${key}=${defaults[key] ?? ""}`).join("\n") + "\n";
  const splitEnv = parseEnv(envText);
  for (const key of LOCAL_ENV_KEYS) {
    if (env[key] !== undefined && splitEnv[key] !== env[key]) {
      throw new Error(`Cannot preserve ${key} during migration`);
    }
  }
  return { settings, envText };
}
