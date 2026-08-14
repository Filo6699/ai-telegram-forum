# claude-tg-forum

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen.svg)](https://nodejs.org)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)

A tiny broker daemon that bridges a **Telegram forum supergroup** to **Claude Code**
via the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk).

**One topic = one Claude session.** A dedicated *"New session"* topic acts as a
launcher: send it a message and the bot spins up a fresh topic + session and
continues the conversation there. Long-idle topics are deleted, so the forum
stays tidy.

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

**Pictures work too.** Send a photo (or an image sent as a file — JPEG, PNG,
GIF, WebP) with an optional caption, in the launcher or inside a topic, and the
agent sees the image itself alongside the caption. An album arrives as several
messages; the agent gets them together at its next step.

**And it sends them back.** The agent can attach local files to anything it
says — a screenshot it just took, a chart, a log, a PDF. Images and video show
up inline, everything else arrives as a file, and its text rides along as the
caption. Files over Telegram's 50 MB upload limit are refused, and the agent is
told so rather than left thinking it delivered them.

`/usage` reports the tokens and cost spent in that topic (in the launcher: the
totals across every topic), followed by your Claude plan's own rate-limit
windows — the 5-hour and weekly meters the CLI's `/usage` shows, drawn as bars
with the time until each resets. Those come from claude.ai, so they cover all your Claude
Code activity, not just this bot; on an API-key or Bedrock/Vertex setup there
are no plan limits and that part is left out.

**Reasoning effort.** Every new session opens with a row of buttons in the
launcher — `low`, `medium`, `high`, `xhigh`, `max`, ticked on the one already in
force — and the topic is only created once that's settled. Ignore it and the
session starts a few seconds later on exactly that level: the bot keeps no
default of its own, so nothing is passed and the CLI resolves it as usual. The
tick is read from the same settings files the CLI reads (`effortLevel` in the
managed, project and user `settings.json`), which is why a level you set in a
terminal shows up here. Touch a button and the launch waits for you: press
levels until you're happy, then **Confirm**, or just stop pressing and it goes
with your last pick a minute later.

`/effort high` sets it without the buttons; `/effort` alone brings them up.
`/effort default` hands the choice back to your settings.
Inside a topic it applies to that topic from its next turn on — a turn already
running finishes on the level it started with — and it's remembered, so the
session comes back on it after an idle shutdown. In the launcher it applies to
the *next* session only, once, and shows up pre-selected in that launch's
picker. The level a turn ran
on appears in its summary line and in `/usage`.

`/stop`, inside a topic, interrupts the turn running there — the running tool is
aborted, any permission prompt still open is denied, and messages you sent while
it was working are dropped. The session itself stays up, so the next message
carries on from where it stopped.

`/resume`, inside a topic, hands back the one line that continues that same
session in a terminal — `cd <the topic's cwd> && claude --resume <session id>`.
`/id` gives just the session id. Both only work inside a session topic, and
only once the first turn has recorded a session id.

## Moving a terminal session to Telegram (`/telegramify`)

A session you started in the terminal already lives on disk, so adopting it is
just a matter of binding a topic to its id — nothing is copied or replayed.

```bash
npm run install-command      # writes ~/.claude/commands/telegramify.md, once
```

Then, inside any Claude Code session:

```
/telegramify
```

It creates a topic named after the session and prints its link. Keep writing
there and the same session continues, with its full history.

**The bot has to be running.** Adoption is refused when it isn't — a topic
nobody polls would just swallow your messages. The running bot keeps
`PID_PATH` (`./data/bot.pid`) warm, and `/telegramify` checks that heartbeat
before touching Telegram.

Straight from the shell, without the slash command:

```bash
npm run telegramify -- --session <uuid>      # a specific session, found anywhere
npm run telegramify -- --cwd /srv/app        # the newest session in that project
npm run telegramify -- --dry-run             # show what it would adopt
```

> Don't keep talking to the same session in both places — the terminal and the
> bot would resume from the same transcript and overwrite each other's tail.
> Adopting a session twice is safe though: you get the existing topic back.

## Working directories

`DEFAULT_CWD` is used unless the launcher message starts with:
- `@alias` — resolved from the `PROJECTS` JSON map in `.env`
- `/absolute/path` — used directly

The chosen cwd is stored per topic, so inside a topic you never repeat it.

## Permissions

Two modes:

- **`auto`** (default, recommended) — auto-approves only the tools in
  `ALLOWED_TOOLS`. Anything else asks you in the topic, with ✅ / ❌ / "always
  allow here" buttons, and waits. No answer within
  `PERMISSION_TIMEOUT_MINUTES` (default 10) counts as a deny, so a turn can't
  hang on a phone nobody is looking at. Commands that look obviously
  destructive (`rm -rf`, `mkfs`, `dd of=/dev/…`, `curl | sh`, fork bombs,
  `shutdown`, …) always ask, even if `Bash` is allowlisted or you granted it a
  blanket approval. Tighten it further by trimming `ALLOWED_TOOLS` — e.g. drop
  `Bash` for a read/edit-only assistant, or drop `Write,Edit` for read-only.
  "Always allow" lasts as long as the topic's live session, not forever.
- **`bypass`** — approves every tool with no checks and never asks.

> ⚠️ **`bypass` and even `auto` let Claude modify files and run shell commands
> in the target `cwd` without asking.** The Bash denylist is defense-in-depth,
> not a sandbox. Only point this at directories and machines you trust, and
> prefer running it as a low-privilege user.

## Cleanup lifecycle

```
active ──idle DELETE_AFTER_HOURS──▶ deleted
```

A sweep runs every 5 min and only ever deletes — topics are never auto-closed,
since closing one pushes a Telegram notification for a topic you've already
stopped using. Deleting also removes the on-disk Claude transcripts for that
cwd. Default: delete after 7 days idle.

Separately, a topic's Claude process is shut down after `SESSION_IDLE_MINUTES`
(default 20) of silence. That's invisible from Telegram — the next message
resumes the same session — but while the process is warm, anything you send is
handed to the agent at its next step instead of waiting for the current turn to
finish.

## Files

| File | Role |
|---|---|
| `src/index.ts`  | bot entry, auth, routing by `message_thread_id` |
| `src/session.ts` | one live Agent SDK session per topic |
| `src/telegramify.ts` | adopt an existing terminal session into a topic |
| `src/heartbeat.ts` | is the broker running? (written by the bot, read by the CLI) |
| `src/install-command.ts` | install the `/telegramify` slash command |
| `src/permission.ts` | tool approval prompts (inline buttons) |
| `src/effort.ts` | reasoning-effort pickers and `/effort` |
| `src/claude.ts` | SDK options: model, effort, permissions, usage accounting |
| `src/tg-tools.ts` | in-process MCP server: the agent's own `send` tool (text + files) |
| `src/status.ts` | live status line, then the turn summary |
| `src/limits.ts` | plan rate limits (5-hour / weekly) behind `/usage` |
| `src/render.ts` | markdown → Telegram messages, with format fallback |
| `src/fmt.ts`    | duration & token formatting |
| `src/media.ts`  | inbound photos in, outbound attachments out |
| `src/cwd.ts`    | parse `@alias` / `/path` prefix, make titles |
| `src/db.ts`     | SQLite state (`node:sqlite`) |
| `src/sweep.ts`  | close/delete idle topics, prune transcripts |
| `src/config.ts` | env loading & validation |

## Limitations

- The Agent SDK has no clean per-turn abort yet; a runaway turn finishes or you
  restart the process. Consider adding `maxTurns` in `claude.ts` if needed.
- The agent decides when to write, through its `send` tool. A long turn isn't
  silent — a live status line tracks tool activity and ends as a summary
  (duration, tool calls, tokens, cost) — but there is no token-by-token
  streaming of the reply itself.
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
