# ai-telegram-forum

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen.svg)](https://nodejs.org)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)

A tiny broker daemon that bridges a **Telegram forum supergroup** to **Claude Code**
or **OpenAI Codex**, via their official TypeScript SDKs.

**One topic = one agent session.** A dedicated *"New session"* topic acts as a
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

**Idle topics cost nothing at the model API.** Claude keeps a warm subprocess
for a configurable window; Codex starts one per turn. Both persist their native
session id and resume from their own on-disk transcript.

## Requirements

- Node.js **≥ 22** (uses the built-in `node:sqlite`, no native build step)
- A CLI login for every provider you intend to use: `claude` for Claude Code,
  `codex login` for Codex. API-key configurations supported by those CLIs work too.

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

Then just keep chatting **inside that topic** — each message resumes that
topic's Claude or Codex session. Writing into a closed topic reopens it.

`PROVIDER=claude|codex` chooses the default for new topics. `/provider codex`
or `/provider claude` in the launcher changes the next launch only; `/provider`
shows buttons. A topic remembers its provider and cannot switch later because
that would abandon its native session history.

**Pictures work too.** Send a photo (or an image sent as a file — JPEG, PNG,
GIF, WebP) with an optional caption, in the launcher or inside a topic, and the
agent sees the image itself alongside the caption. Telegram sends an album as
several updates; the bot briefly collects them and gives the agent one message.

**So does everything else you can attach.** A voice message, a video, a music
file, a GIF, a video note, an animated sticker, a `.md` spec, a CSV — anything
that isn't an image is saved under `data/inbox/` and handed to the agent as a
path, prefixed with a line saying what it is: `[voice message (0:12), 45 KB]`.
Images are kept there too so Codex can receive the local paths its SDK expects;
Claude receives the same bytes as base64. Static stickers are pictures. The kinds with no file
behind them — a location, a venue, a contact, a poll, a dice roll — arrive as
the words that describe them. Your caption always rides along.

Telegram caps what a bot may download at 20 MB; over that you're told rather
than ignored, as you are for the few kinds the Bot API won't hand a bot at all
(a story, say). Nothing is dropped in silence except Telegram's own service
messages.

**And it sends them back.** The agent can attach local files to anything it
says — a screenshot it just took, a chart, a log, a PDF. Images and video show
up inline, everything else arrives as a file, and its text rides along as the
caption. Files over Telegram's 50 MB upload limit are refused, and the agent is
told so rather than left thinking it delivered them.

`/usage` reports the tokens spent in that topic (in the launcher: the totals
across every topic). Claude turns also report SDK cost and are followed by your Claude plan's own rate-limit
windows — the 5-hour and weekly meters the CLI's `/usage` shows, drawn as bars
with the time until each resets. Those come from claude.ai, so they cover all your Claude
Code activity, not just this bot; on an API-key or Bedrock/Vertex setup there
are no plan limits and that part is left out. Codex reports tokens through its
SDK and ChatGPT rate-limit windows through its local app-server. It does not
report authoritative per-turn cost, so the bot does not invent one.
At the end of each Codex turn, its compact summary instead shows the preset,
native session's cumulative tokens, and an estimated share of the weekly
allowance spent by that session (`✅ 1:39 · Decent · 🔧4 · Σ4.8m · 🧠≈0.8%`).
The estimate weights new input, cached input, and output using OpenAI's Codex
credit rates, including the fast-mode multiplier, against a locally calibrated
weekly capacity. It is deliberately marked approximate because ChatGPT does
not publish that capacity. Native usage is read after the turn, so it never
consumes a model request; if it is unavailable, that field is simply omitted
(with the topic's locally counted tokens as the session-total fallback). Exact
shared-account windows and reset times remain available under `/usage`.

**Model and reasoning effort.** Every new session opens with one provider-specific picker in the
launcher, and the topic is only created once that's settled. Claude shows its
models and supported effort levels as separate rows. Codex shows one row of
presets: each button selects a model, effort, and regular/fast service tier
together. Configure the buttons with `CODEX_PRESETS` and the initial tick with
`CODEX_DEFAULT_PRESET`. The example config provides **Flash** (Sol, low, fast),
**Normal** (Sol, medium), and **Decent** (Sol, high), with Decent selected by
default. `light` is accepted in the JSON as an alias for Codex's `low` effort.

```dotenv
CODEX_PRESETS={"Flash":{"model":"gpt-5.6-sol","effort":"low","fast":true},"Normal":{"model":"gpt-5.6-sol","effort":"medium"},"Decent":{"model":"gpt-5.6-sol","effort":"high"}}
CODEX_DEFAULT_PRESET=Decent
```

Ignore the picker and the session starts a few seconds later on exactly what's
ticked. Touch a button and the launch waits for you: press buttons until you're
happy, then **Confirm**, or just stop pressing and it goes with your last pick
a minute later. **Cancel** aborts the launch before a topic or agent session is
created. Once settled, that same message turns into the launch line — a launch
is one message in the launcher, not a picker plus a note.

`/effort high` sets it without the buttons; `/effort` alone brings them up.
`/effort default` hands the choice back to your settings.
Inside a topic it applies to that topic from its next turn on — a turn already
running finishes on the level it started with — and it's remembered, so the
session comes back on it after an idle shutdown. In the launcher it applies to
the *next* session only, once. For Codex it appears as a pre-selected **Custom**
choice beside the configured presets. The level a turn ran
on appears in its summary line and in `/usage`.

`/model` works the same way, one for one: Claude offers `opus`, `sonnet`,
`haiku`, and `fable`; Codex offers its configured presets alongside `sol`,
`terra`, `luna`, and full model ids. A Codex preset button applies the preset's
model, effort, and service tier together; an individual model button only
changes the model.
`/model` alone brings up the buttons. `/model default` hands it back to the
provider's model in `.env` — which is what the
tick sits on when nothing is picked, so the default is a button like any other.
Inside a topic it swaps the model on the live session from the next turn on and
is remembered across an idle shutdown; in the launcher it becomes the next
Codex launch's **Custom** choice (or pre-selects Claude's model row). The model
a turn ran on is in its summary line and in `/usage`.

`/stop`, inside a topic, interrupts the turn running there — the running tool is
aborted, any permission prompt still open is denied, and messages you sent while
it was working remain queued. The session itself stays up and continues with
them. The copy of the first prompt in a newly created topic has a permanent
**Cancel** button that performs the same immediate stop without typing the
command.

`/resume`, inside a topic, hands back the one line that continues that same
session in a terminal — `claude --resume <id>` or `codex resume <id>` in its cwd.
`/id` gives just the session id. Both only work inside a session topic, and
only once the first turn has recorded a session id.

## Moving a Claude terminal session to Telegram (`/telegramify`)

A Claude session you started in the terminal already lives on disk, so adopting it is
just a matter of binding a topic to its id — nothing is copied or replayed into
the session.

```bash
npm run install-command      # writes ~/.claude/commands/telegramify.md, once
```

Then, inside any Claude Code session:

```
/telegramify
```

It creates a topic named after the session and prints its link. Keep writing
there and the same session continues, with its full history.

The new topic opens on the agent's last reply from the terminal, re-posted so
you're not picking up the thread against a blank screen. Only the finished
answer travels — not the commentary between tool calls — and a session
interrupted mid-tool has nothing to carry, so the topic just starts empty.

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

## Moving a Codex terminal session to Telegram (`codexify`)

Codex exposes `CODEX_THREAD_ID` inside a running session, so ask it to run the
broker's command (use the broker's absolute directory when the session is in a
different project):

```bash
cd /path/to/ai-telegram-forum && npm run codexify
```

From a regular shell, select a saved thread explicitly or adopt the newest CLI
thread for a cwd:

```bash
npm run codexify -- --session <uuid>
npm run codexify -- --cwd /srv/app
npm run codexify -- --dry-run
```

Like `/telegramify`, this binds the existing native transcript rather than
copying it, carries the last completed final answer into the topic when one is
available, refuses duplicate adoption, and requires a live broker heartbeat.

## Working directories

`DEFAULT_CWD` is used unless the launcher message starts with:
- `@alias` — resolved from the `PROJECTS` JSON map in `.env`
- `/absolute/path` — used directly

The chosen cwd is stored per topic, so inside a topic you never repeat it.

## Permissions

Two modes:

- **`auto`** (default, recommended) — for Claude, auto-approves only the tools in
  `ALLOWED_TOOLS`. Anything else asks you in the topic, with ✅ / ❌ / "always
  allow here" buttons, and waits. No answer within
  `PERMISSION_TIMEOUT_MINUTES` (default 10) counts as a deny, so a turn can't
  hang on a phone nobody is looking at. Commands that look obviously
  destructive (`rm -rf`, `mkfs`, `dd of=/dev/…`, `curl | sh`, fork bombs,
  `shutdown`, …) always ask, even if `Bash` is allowlisted or you granted it a
  blanket approval. Tighten it further by trimming `ALLOWED_TOOLS` — e.g. drop
  `Bash` for a read/edit-only assistant, or drop `Write,Edit` for read-only.
  "Always allow" lasts as long as the topic's live session, not forever.
- **`auto` for Codex** — runs with `approvalPolicy: never` inside Codex's
  `workspace-write` sandbox, with network access. The Codex TypeScript SDK does
  not expose interactive approval callbacks, so it cannot wait on Telegram
  buttons; sandbox violations are returned to the agent as failures.
- **`bypass`** — Claude skips its checks; Codex uses `danger-full-access`.
  Neither asks before running a tool.

> ⚠️ **`bypass` and even `auto` let the agent modify files and run shell commands
> in the target `cwd` without asking.** Claude's Bash denylist is defense-in-depth,
> not a sandbox. Only point this at directories and machines you trust, and
> prefer running it as a low-privilege user.

## Cleanup lifecycle

```
active ──idle DELETE_AFTER_HOURS──▶ deleted
```

A sweep runs every 5 min and only ever deletes — topics are never auto-closed,
since closing one pushes a Telegram notification for a topic you've already
stopped using. Default: delete after 7 days idle. The provider session on disk
survives: deleting a topic drops the Telegram side and nothing else, so the
transcript stays resumable from the terminal.

Separately, Claude's warm child and the in-memory topic object are dropped after
`SESSION_IDLE_MINUTES` (default 20) of silence. That's invisible from Telegram:
the next message resumes from disk. Claude can consume a new message at its next
step while a turn is running. The current Codex SDK has no steering API, so a
message received during a Codex turn becomes the next turn automatically.

## Files

| File | Role |
|---|---|
| `src/index.ts`  | bot entry, auth, routing by `message_thread_id` |
| `src/session.ts` | one live Agent SDK session per topic |
| `src/telegramify.ts` | adopt an existing terminal session into a topic |
| `src/codexify.ts` | adopt an existing Codex terminal session into a topic |
| `src/heartbeat.ts` | is the broker running? (written by the bot, read by the CLI) |
| `src/install-command.ts` | install the `/telegramify` slash command |
| `src/permission.ts` | tool approval prompts (inline buttons) |
| `src/picker.ts` | the inline-button picker `/effort` and `/model` share |
| `src/preset-config.ts` | Codex launch-preset config and service-tier types |
| `src/preset.ts` | the Codex launch-preset picker |
| `src/effort.ts` | reasoning-effort buttons and `/effort` |
| `src/model.ts` | model buttons and `/model` |
| `src/provider.ts` | Claude/Codex selection and `/provider` |
| `src/claude.ts` | SDK options: model, effort, permissions, usage accounting |
| `src/codex.ts` | Codex SDK options, thread/input/event adaptation |
| `src/codex-app-server.ts` | one-shot requests to Codex's local app-server |
| `src/codex-limits.ts` | Codex ChatGPT rate limits behind `/usage` |
| `src/codex-tg-server.ts` | Codex's topic-bound stdio MCP `send` server |
| `src/tg-tools.ts` | shared `send` implementation + Claude's in-process MCP server |
| `src/status.ts` | live status line, then the turn summary |
| `src/limits.ts` | plan rate limits (5-hour / weekly) behind `/usage` |
| `src/render.ts` | markdown → Telegram messages, with format fallback |
| `src/fmt.ts`    | duration & token formatting |
| `src/media.ts`  | inbound photos & files in, outbound attachments out |
| `src/cwd.ts`    | parse `@alias` / `/path` prefix, make titles |
| `src/db.ts`     | SQLite state (`node:sqlite`) |
| `src/sweep.ts`  | delete idle Telegram topics (never their sessions) |
| `src/config.ts` | env loading & validation |

## Limitations

- Codex's TypeScript SDK does not expose mid-turn steering, interactive approval
  callbacks, generated titles, or cost. The broker uses the
  closest safe behavior described above. `/stop`, resume, model/effort changes,
  images, tool status, token usage, and the direct `send`/file tool do work.
- The agent decides when to write, through its `send` tool. A long turn isn't
  silent — a live status line tracks tool activity and ends as a summary
  (duration, tool calls, and provider-specific usage) — but there is no token-by-token
  streaming of the reply itself.
- Bots can't create groups — the forum itself is created by you, once.

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
