/**
 * Install the Telegram adoption command for Claude Code and Codex.
 *
 * The commands have to work from any project, so their global forms live in
 * each provider's user directory with this checkout's path baked in.
 *
 *   npm run install-command
 *     -> ~/.claude/commands/telegramify.md
 *     -> ~/.agents/skills/telegramify/SKILL.md
 *   npm run install-command -- --project   # install both for this repo only
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const claudeBody = `---
description: Move this Claude Code session to Telegram and continue it from a forum topic
allowed-tools: Bash(npm --prefix ${repo} run telegramify:*)
---

!\`npm --prefix ${repo} run --silent telegramify -- --provider claude --session "$CLAUDE_CODE_SESSION_ID" --cwd "$PWD"\`

The output above comes from the ai-telegram-forum broker. Report to the user in one
line whether this session moved to Telegram, and pass on the topic link (or the
error) verbatim. Don't do anything else.
`;

const codexBody = `---
name: telegramify
description: Move the current Codex session to Telegram and continue it from a forum topic. Use when the user asks to telegramify, adopt, move, or continue this session in Telegram.
---

Run this command with the shell:

\`\`\`bash
npm --prefix ${repo} run --silent telegramify -- --provider codex --session "$CODEX_THREAD_ID" --cwd "$PWD"
\`\`\`

The output comes from the ai-telegram-forum broker. Report in one line whether
the session moved to Telegram, and pass on the topic link or error verbatim. Do
nothing else.
`;

const project = process.argv.includes("--project");
const claudeDir = project
  ? join(process.cwd(), ".claude", "commands")
  : join(homedir(), ".claude", "commands");
const codexDir = project
  ? join(process.cwd(), ".agents", "skills", "telegramify")
  : join(homedir(), ".agents", "skills", "telegramify");

mkdirSync(claudeDir, { recursive: true });
mkdirSync(codexDir, { recursive: true });
const claudePath = join(claudeDir, "telegramify.md");
const codexPath = join(codexDir, "SKILL.md");
writeFileSync(claudePath, claudeBody);
writeFileSync(codexPath, codexBody);
console.log(`Installed /telegramify for Claude Code -> ${claudePath}`);
console.log(`Installed $telegramify for Codex -> ${codexPath}`);
