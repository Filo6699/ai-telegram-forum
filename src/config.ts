import "dotenv/config";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function reqNum(name: string): number {
  const raw = req(name);
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got: ${raw}`);
  return n;
}

/**
 * The launcher topic. Messages in Telegram's General topic carry no
 * `message_thread_id`, so `General` (the default) maps to undefined.
 */
function parseLauncher(raw: string | undefined): number | undefined {
  if (!raw || raw.trim().toLowerCase() === "general") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`LAUNCHER_THREAD_ID must be a number or "General", got: ${raw}`);
  }
  return n;
}

function parseProjects(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    throw new Error(`PROJECTS is not valid JSON: ${raw}`);
  }
}

const hours = (name: string, fallback: number) =>
  (Number(process.env[name] ?? fallback)) * 3600_000;

export const cfg = {
  token: req("BOT_TOKEN"),
  chatId: reqNum("FORUM_CHAT_ID"),
  allowedUserId: reqNum("ALLOWED_USER_ID"),
  launcherThreadId: parseLauncher(process.env.LAUNCHER_THREAD_ID),

  defaultCwd: req("DEFAULT_CWD"),
  projects: parseProjects(process.env.PROJECTS),

  model: process.env.MODEL ?? "claude-opus-4-8",
  // "auto": auto-approve the ALLOWED_TOOLS allowlist, deny everything else,
  // and block obviously destructive shell commands. "bypass": allow all tools.
  permission: (process.env.PERMISSION ?? "auto") as "auto" | "bypass",
  allowedTools: (process.env.ALLOWED_TOOLS ?? "Read,Glob,Grep,Edit,Write,Bash")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean),

  deleteAfterMs: hours("DELETE_AFTER_HOURS", 168),

  // How long a topic's Claude process is kept alive after its last message.
  // While it lives, new messages reach the agent mid-turn; once it's gone the
  // next message resumes the same session from disk.
  sessionIdleMs: Number(process.env.SESSION_IDLE_MINUTES ?? 20) * 60_000,

  // How long a permission prompt waits for a button press before denying.
  permissionTimeoutMs: Number(process.env.PERMISSION_TIMEOUT_MINUTES ?? 10) * 60_000,

  dbPath: process.env.DB_PATH ?? "./data/state.db",
  // Heartbeat file the running bot keeps warm; `/telegramify` won't adopt a
  // session into a forum nobody is listening to.
  pidPath: process.env.PID_PATH ?? "./data/bot.pid",
} as const;
