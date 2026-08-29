# AGENTS.md

Telegram forum ↔ Claude Code / Codex broker. One forum topic = one native agent session.
Read `README.md` for the user-facing picture; this file is the working contract.

## Layout

| File | Role |
|---|---|
| `src/index.ts`  | bot entry, auth, routing by `message_thread_id` |
| `src/session.ts` | one live SDK session per topic; turn lifecycle |
| `src/telegramify.ts` | CLI: adopt an existing on-disk session into a new topic |
| `src/install-command.ts` | writes the `/telegramify` slash command for Claude Code |
| `src/heartbeat.ts` | broker liveness file: written by the bot, read by the CLI |
| `src/permission.ts` | tool approval prompts + their inline buttons |
| `src/effort.ts` | reasoning-effort pickers, `/effort`, level parsing |
| `src/claude.ts` | SDK options: model, effort, permission policy, usage accounting |
| `src/codex.ts` | Codex SDK options, thread/input/event adaptation |
| `src/codex-tg-server.ts` | topic-bound stdio MCP server for Codex |
| `src/provider.ts` | provider selection and labels |
| `src/tg-tools.ts` | shared send implementation + Claude's in-process MCP server |
| `src/status.ts` | the live status line / turn summary message |
| `src/limits.ts` | plan rate limits (5-hour / weekly) behind `/usage` |
| `src/render.ts` | markdown → topic messages, with format fallback |
| `src/fmt.ts`    | duration & token formatting |
| `src/media.ts`  | inbound photos → base64 image blocks for the user message |
| `src/html.ts`   | markdown → Telegram HTML (fallback when MarkdownV2 fails) |
| `src/cwd.ts`    | `@alias` / `/path` prefix parsing, titles |
| `src/db.ts`     | SQLite state (`node:sqlite`) |
| `src/sweep.ts`  | delete idle Telegram topics (never their sessions) |
| `src/config.ts` | env loading & validation |

## Commands

```bash
npm start          # run
npm run dev        # watch mode
npm run typecheck  # tsc --noEmit — must be clean before you commit

npm run install-command          # install /telegramify into ~/.claude/commands
npm run telegramify -- --dry-run # adopt the current terminal session into a topic
```

## Rules

- **The agent speaks for itself.** Everything the user reads comes from the
  agent calling `mcp__tg__send`; the transcript is never relayed. Don't add
  "🔧 Bash"-style activity posts — tool calls belong in the live status line,
  which is one bot-owned message per turn, edited in place.
- **Never post a partial thought.** One `send` call is one finished message.
  Assistant text is still buffered, but only as the fallback for a turn that
  ended without the agent ever calling `send` — losing a reply the session
  recorded is the bug this design exists to prevent. Errors always get posted,
  regardless of that fallback.
- **A topic's session outlives its turns.** Claude's `TopicSession` feeds the SDK from an
  iterator that stays open, so an incoming message is delivered at the agent's
  next step — never interrupt a running turn to hand it over, and never add a
  queue in front of it. Anything that shuts a topic down (sweep, idle timeout)
  must go through `endSession`, or the child process is orphaned.
  Codex's SDK has no steering API: input received mid-turn is consumed as the
  next turn, without interrupting the running one. Its subprocess is per-turn,
  but the same persisted thread id and in-memory topic object continue.
- **Callback queries are inbound too.** They're the one path that doesn't go
  through the message handler's gate, so every handler must check
  `ALLOWED_USER_ID` itself. A permission prompt must always settle — button,
  timeout, or session end — or the tool call waits forever.
- **Never await a button from inside a message handler.** grammy's polling runs
  updates one at a time, so a handler that waits on a callback query blocks the
  update that would settle it — the launch flow detaches (`void launch(…)`) for
  exactly that reason. And a `callback_query:data` handler that doesn't own the
  callback must pass it on with `next()`, or the handler registered after it
  never sees anything.
- **Adoption binds, it doesn't copy.** `/telegramify` only writes a topic row
  pointing at a session id that already exists on disk — never replay or import
  a transcript. One session id belongs to at most one topic, or the terminal and
  the bot resume from the same file and clobber each other's tail. It also
  refuses to run unless `heartbeat.ts` says the bot is up: a topic nobody polls
  looks adopted and answers nothing.
- **Never delete an agent session.** Cleanup deletes Telegram topics and their
  DB rows — nothing under `~/.claude/projects/` or `~/.codex/sessions/`. A transcript is the user's
  work, it long outlives the topic that happened to be pointed at it, and one
  cwd's folder holds every session for that project, terminal ones included:
  deleting it takes out history the bot never created. Sessions end
  (`endSession`) — they are never removed from disk. Same for `data/inbox`
  attachments the agent may still be holding a path to.
- Keep it dependency-light and single-user. Don't add a runtime dependency or
  multi-user auth without discussing the design first.
- Don't touch `.env` or `data/` — both are git-ignored and hold real state.
- Every Telegram API call can fail; log and continue rather than crashing the
  bot process.

## Commit & push

After each feature (or fix) is implemented and `npm run typecheck` passes,
commit it and push to `origin` right away. One feature = one commit; don't let
finished work sit uncommitted in the working tree.

```bash
git add -A && git commit -m "<what changed>" && git push
```
