/** Shared by command matching and Telegram's command menu. Order breaks ties. */
export const botCommands = [
  { command: "usage", description: "Tokens/cost here (or all in the launcher) + plan limits" },
  { command: "btw", description: "Ask a side question without interrupting the main task" },
  { command: "provider", description: "Next session agent: Claude, Codex, or OpenRouter" },
  { command: "effort", description: "Reasoning effort: /effort high, or /effort for buttons" },
  { command: "progress", description: "Progress updates: off, brief, detailed" },
  { command: "toolcalls", description: "Tool calls: off, only_file_edits, full" },
  { command: "model", description: "Model: /model sonnet, or /model for buttons" },
  { command: "stop", description: "Interrupt the turn running in this topic" },
  { command: "resume", description: "Shell command to continue this session in a terminal" },
  { command: "id", description: "Agent session id of this topic" },
] as const;

type Command = (typeof botCommands)[number]["command"];
const aliases: Readonly<Record<string, Command>> = { agent: "provider" };
const candidates = [
  ...botCommands.map(({ command }) => ({ name: command, command })),
  ...Object.entries(aliases).map(([name, command]) => ({ name, command })),
];

export type ParsedCommand =
  | { kind: "prompt" }
  | { kind: "ignored" }
  | { kind: "command"; command: `/${Command}`; args: string };

/** Edit distance including adjacent transpositions, as in usaeg -> usage. */
function distance(input: string, name: string): number {
  let previous = Array.from({ length: name.length + 1 }, (_, i) => i);
  let beforePrevious = previous;
  for (let i = 1; i <= input.length; i++) {
    const current = [i];
    for (let j = 1; j <= name.length; j++) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (input[i - 1] === name[j - 1] ? 0 : 1),
      );
      if (i > 1 && j > 1 && input[i - 1] === name[j - 2] && input[i - 2] === name[j - 1]) {
        current[j] = Math.min(current[j]!, beforePrevious[j - 2]! + 1);
      }
    }
    beforePrevious = previous;
    previous = current;
  }
  return previous[name.length]!;
}

/** Every leading slash is consumed; nonempty names always match, without a cutoff. */
export function parseCommand(text: string, botUsername: string): ParsedCommand {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return { kind: "prompt" };
  const [, token = "", args = ""] = /^\/(\S*)(?:\s+([\s\S]*))?$/.exec(trimmed)!;
  const [rawName = "", addressee] = token.split("@");
  if (addressee !== undefined && addressee.toLowerCase() !== botUsername.toLowerCase()) {
    return { kind: "ignored" };
  }
  const name = rawName.toLowerCase();
  if (!name) return { kind: "ignored" };

  const exact = candidates.find((candidate) => candidate.name === name);
  if (exact) return { kind: "command", command: `/${exact.command}`, args };

  // Complete abbreviations first. Among completions choose the shortest one;
  // otherwise choose the smallest edit distance, keeping menu order on ties.
  const prefixes = candidates.filter((candidate) => candidate.name.startsWith(name));
  const choices = prefixes.length ? prefixes : candidates;
  let best = choices[0]!;
  let bestDistance = distance(name, best.name);
  for (const candidate of choices.slice(1)) {
    const score = distance(name, candidate.name);
    if (score < bestDistance) {
      best = candidate;
      bestDistance = score;
    }
  }
  return { kind: "command", command: `/${best.command}`, args };
}
