/**
 * Install the `/telegramify` slash command for Claude Code.
 *
 * The command has to work from any project, so it lives in `~/.claude/commands`
 * with this checkout's path baked in — that's the only thing it needs to know.
 *
 *   npm run install-command            # -> ~/.claude/commands/telegramify.md
 *   npm run install-command -- --project   # -> <cwd>/.claude/commands (this repo only)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const body = `---
description: Move this Claude Code session to Telegram and continue it from a forum topic
allowed-tools: Bash(npm --prefix ${repo} run telegramify:*)
---

!\`npm --prefix ${repo} run --silent telegramify -- --session "$CLAUDE_CODE_SESSION_ID" --cwd "$PWD"\`

The output above comes from the ai-telegram-forum broker. Report to the user in one
line whether this session moved to Telegram, and pass on the topic link (or the
error) verbatim. Don't do anything else.
`;

const dir = process.argv.includes("--project")
  ? join(process.cwd(), ".claude", "commands")
  : join(homedir(), ".claude", "commands");

mkdirSync(dir, { recursive: true });
const path = join(dir, "telegramify.md");
writeFileSync(path, body);
console.log(`Installed /telegramify -> ${path}`);
