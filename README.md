# claude-tg-forum

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen.svg)](https://nodejs.org)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)

A tiny broker daemon that bridges a **Telegram forum supergroup** to **Claude Code**
via the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk).

**One topic = one Claude session.** A dedicated *"New session"* topic acts as a
launcher: send it a message and the bot spins up a fresh topic + session and
continues the conversation there. Idle topics are auto-closed and eventually
deleted, so the forum stays tidy.

```
        Telegram forum (supergroup, Topics ON)
                     │  long polling
                     ▼
              ┌──────────────┐
              │   this bot   │  auth by user_id · DB: thread_id ↔ session_id ↔ cwd
              └──────┬───────┘
     route by message_thread_id
        ┌───────┬────┴────┬───────────┐
        ▼       ▼         ▼           ▼
   topic 1   topic 2   topic 3   "New session" (launcher)
  session A session B session C
```

Because each turn is a separate `query({ resume })` call, **idle topics cost
nothing at runtime** — a sleeping topic is just one row in SQLite. A subprocess
only lives while a turn is being answered.

## Requirements

- Node.js **≥ 22** (uses the built-in `node:sqlite`, no native build step)
- A Claude Code auth setup usable by the Agent SDK (same login you use for the CLI)

## Setup

### 1. Create the bot
1. Talk to [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token.
2. In BotFather, `/setprivacy` → **Disable** so the bot can read all group messages.

### 2. Create the forum
1. Create a Telegram **group**, then in group settings enable **Topics** (this
   turns it into a forum supergroup).
2. Add your bot and promote it to **admin** with *Manage Topics* permission.
3. Create a topic named **"New session"** (or "Новая сессия").

### 3. Collect the ids
Send one message in the group and one in the *New session* topic, then:

```bash
curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | jq
```

- `message.chat.id` → `FORUM_CHAT_ID` (starts with `-100`)
- `message.from.id`  → `ALLOWED_USER_ID` (your own id; or ask @userinfobot)
- `message.message_thread_id` of the *New session* topic → `LAUNCHER_THREAD_ID`

### 4. Configure & run
```bash
cp .env.example .env      # then fill it in
npm install
npm start                 # or: npm run dev  (watch mode)
```

## Usage

Everything happens by messaging the **New session** topic (or the General topic):

| You send | What happens |
|---|---|
| `fix the flaky login test` | new topic, session runs in `DEFAULT_CWD` |
| `@myrepo add a health endpoint` | new topic, cwd = `PROJECTS.myrepo` |
| `/srv/app bump deps` | new topic, cwd = `/srv/app` |

Then just keep chatting **inside that topic** — each message resumes the same
Claude session. Writing into a closed (archived) topic reopens it.

## Working directories

`DEFAULT_CWD` is used unless the launcher message starts with:
- `@alias` — resolved from the `PROJECTS` JSON map in `.env`
- `/absolute/path` — used directly

The chosen cwd is stored per topic, so inside a topic you never repeat it.

## Permissions

The bot runs headless, so there's no interactive prompt to answer — every tool
call must be resolved automatically. Two modes:

- **`auto`** (default, recommended) — auto-approves only the tools in
  `ALLOWED_TOOLS`, denies everything else, and blocks obviously destructive
  shell commands (`rm -rf`, `mkfs`, `dd of=/dev/…`, `curl | sh`, fork bombs,
  `shutdown`, …). Tighten it further by trimming `ALLOWED_TOOLS` — e.g. drop
  `Bash` for a read/edit-only assistant, or drop `Write,Edit` for read-only.
- **`bypass`** — approves every tool with no checks.

> ⚠️ **`bypass` and even `auto` let Claude modify files and run shell commands
> in the target `cwd` without asking.** The Bash denylist is defense-in-depth,
> not a sandbox. Only point this at directories and machines you trust, and
> prefer running it as a low-privilege user.

## Cleanup lifecycle

```
active ──idle CLOSE_AFTER_HOURS──▶ closed ──idle DELETE_AFTER_HOURS──▶ deleted
  ▲                                   │
  └──────── you message it ───────────┘ (reopen)
```

A sweep runs every 5 min. `deleted` also removes the on-disk Claude transcripts
for that cwd. Defaults: close after 36h, delete 7 days after closing.

## Files

| File | Role |
|---|---|
| `src/index.ts`  | bot entry, auth, routing by `message_thread_id` |
| `src/claude.ts` | one turn via the Agent SDK, streaming to Telegram |
| `src/stream.ts` | throttled, multi-message Telegram renderer |
| `src/cwd.ts`    | parse `@alias` / `/path` prefix, make titles |
| `src/db.ts`     | SQLite state (`node:sqlite`) |
| `src/sweep.ts`  | close/delete idle topics, prune transcripts |
| `src/config.ts` | env loading & validation |

## Limitations

- The Agent SDK has no clean per-turn abort yet; a runaway turn finishes or you
  restart the process. Consider adding `maxTurns` in `claude.ts` if needed.
- Telegram edits are throttled to ~1/sec; very fast token streams appear in
  bursts, not per-token.
- Bots can't create groups — the forum itself is created by you, once.
- Text only for now — images and file attachments aren't handled.

## Security

- **Single-user by design.** Every update is checked against `ALLOWED_USER_ID`
  and dropped otherwise. There's no multi-user auth — don't expose one bot to
  people you don't trust.
- **Keep `.env` secret.** It holds your bot token; it's git-ignored by default.
- **The bot can touch your filesystem.** Run it as a dedicated low-privilege
  user, point `DEFAULT_CWD` / `PROJECTS` only at repos you're fine with an agent
  editing, and read the [Permissions](#permissions) section before switching to
  `bypass`.
- Found a vulnerability? Please open a private report via GitHub Security
  Advisories rather than a public issue.

## Contributing

Issues and PRs welcome. Before opening a PR, run `npm run typecheck`. Keep the
project dependency-light and the single-user model intact unless we discuss a
design for multi-user first.

## License

[MIT](./LICENSE) © Filo6699
