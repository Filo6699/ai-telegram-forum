export const progressLevels = ["off", "brief", "detailed"] as const;
export const toolcallModes = ["off", "only_file_edits", "full"] as const;
export type Progress = (typeof progressLevels)[number];
export type Toolcalls = (typeof toolcallModes)[number];

export function progressInstruction(level: Progress): string {
  const instruction = {
    off: "Do not send progress updates. Send the final answer, blocking questions, and important warnings.",
    brief: "Send a short initial update and concise updates at major milestones or when the plan changes. Avoid routine step-by-step narration.",
    detailed: "Send an initial plan and frequent meaningful progress updates: what you found, what you changed, and what you will check next. Do not expose private reasoning or narrate every tool call.",
  }[level];
  return `[Telegram communication preference: ${level}. ${instruction} Use mcp__tg__send for each complete message. This preference controls progress updates only, not the detail needed in the final answer.]`;
}

export function toolcallText(mode: Toolcalls, name: string, input: unknown): string | null {
  if (mode === "off") return null;
  const edits = /^(Edit|MultiEdit|Write|NotebookEdit|apply_patch)$/i.test(name);
  if (mode === "only_file_edits" && !edits) return null;
  const data = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : null;
  const firstString = (...values: unknown[]): string | null =>
    values.find((value): value is string => typeof value === "string" && value.trim().length > 0) ?? null;

  // Codex app-server items carry ids, status and duplicated command fields.
  // Show the useful argument only, including for Claude and OpenRouter tools.
  let detail = typeof input === "string" ? input : firstString(
    data?.command,
    data?.file_path,
    data?.path,
    data?.url,
    data?.query,
    data?.search_query,
  );
  if (!detail && Array.isArray(data?.changes)) {
    detail = data.changes
      .map((change: unknown) => change && typeof change === "object"
        ? firstString((change as Record<string, unknown>).path) : null)
      .filter(Boolean)
      .join(", ");
  }
  if (!detail) return `🔧 ${name}`;
  const compact = detail.replace(/\s+/g, " ").trim();
  const max = 200;
  return `🔧 ${name}: ${compact.length > max ? `${compact.slice(0, max - 1)}…` : compact}`;
}
