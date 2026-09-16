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
  const raw = typeof input === "string" ? input : JSON.stringify(input ?? {}, null, 2);
  // Bound notifications; arbitrary tool input must not break the code fence.
  const detail = raw.replace(/```/g, "` ` `");
  return `🔧 ${name}\n\n\`\`\`\n${detail.slice(0, 3000)}${detail.length > 3000 ? "\n… (truncated)" : ""}\n\`\`\``;
}
