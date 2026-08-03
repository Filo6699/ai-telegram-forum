import "dotenv/config";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
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
  chatId: Number(req("FORUM_CHAT_ID")),
  allowedUserId: Number(req("ALLOWED_USER_ID")),
  launcherThreadId: Number(req("LAUNCHER_THREAD_ID")),

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

  closeAfterMs: hours("CLOSE_AFTER_HOURS", 36),
  deleteAfterMs: hours("DELETE_AFTER_HOURS", 168),

  dbPath: process.env.DB_PATH ?? "./data/state.db",
} as const;
