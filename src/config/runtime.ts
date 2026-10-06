import { parseCodexPresets, parseDefaultCodexPreset } from "./codex-presets.ts";
import { parseOpenRouterPresets } from "./openrouter-presets.ts";
import { normalizeOpenRouterModel } from "./openrouter-model.ts";
import type { Settings } from "./settings.ts";

/** Combine portable settings with the six machine-specific environment values. */
export function buildConfig(settings: Settings, env: Record<string, string | undefined>) {
  function req(name: string): string {
    const value = env[name];
    if (!value) throw new Error(`Missing required env var: ${name}`);
    return value;
  }
  function reqNum(name: string): number {
    const value = Number(req(name));
    if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
    return value;
  }

  const codexPresets = parseCodexPresets(settings.CODEX_PRESETS === undefined
    ? undefined : JSON.stringify(settings.CODEX_PRESETS));
  const openrouterPresets = parseOpenRouterPresets(settings.OPENROUTER_PRESETS === undefined
    ? undefined : JSON.stringify(settings.OPENROUTER_PRESETS));
  const openrouterModel = normalizeOpenRouterModel(settings.OPENROUTER_MODEL);
  if (!openrouterModel) throw new Error("config.json OPENROUTER_MODEL must be a model id or an openrouter.ai link");
  const openrouterApiKey = env.OPENROUTER_API_KEY?.trim() ?? "";
  const openrouterEnabled = Boolean(openrouterApiKey);
  if (settings.PROVIDER === "openrouter" && !openrouterEnabled) {
    throw new Error("config.json PROVIDER=openrouter requires a non-empty OPENROUTER_API_KEY in .env");
  }

  return {
    token: req("BOT_TOKEN"),
    chatId: reqNum("FORUM_CHAT_ID"),
    allowedUserId: reqNum("ALLOWED_USER_ID"),
    launcherThreadId: settings.LAUNCHER_THREAD_ID === "General" ? undefined : settings.LAUNCHER_THREAD_ID,
    defaultCwd: settings.DEFAULT_CWD,
    projects: settings.PROJECTS,
    provider: settings.PROVIDER,
    claudeModel: settings.CLAUDE_MODEL,
    codexModel: settings.CODEX_MODEL,
    codexEffort: settings.CODEX_EFFORT,
    openrouterApiKey,
    openrouterEnabled,
    openrouterModel,
    openrouterPresets,
    openrouterHistoryPath: settings.OPENROUTER_HISTORY_PATH,
    openrouterMaxSteps: settings.OPENROUTER_MAX_STEPS,
    openrouterTurnTimeoutMs: settings.OPENROUTER_TURN_TIMEOUT_MINUTES * 60_000,
    openrouterMaxToolOutput: settings.OPENROUTER_MAX_TOOL_OUTPUT,
    openrouterContextWindow: settings.OPENROUTER_CONTEXT_WINDOW,
    codexPresets,
    codexDefaultPreset: parseDefaultCodexPreset(settings.CODEX_DEFAULT_PRESET, codexPresets),
    permission: settings.PERMISSION,
    allowedTools: settings.ALLOWED_TOOLS,
    deleteAfterMs: settings.DELETE_AFTER_HOURS * 3600_000,
    sessionIdleMs: settings.SESSION_IDLE_MINUTES * 60_000,
    permissionTimeoutMs: settings.PERMISSION_TIMEOUT_MINUTES * 60_000,
    dbPath: env.DB_PATH ?? "./data/state.db",
    inboxPath: settings.INBOX_PATH,
    pidPath: env.PID_PATH ?? "./data/bot.pid",
  };
}
