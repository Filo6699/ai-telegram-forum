# AGENTS.md

Telegram forum ↔ Claude Code broker. One forum topic = one Agent SDK session.
Read `README.md` for the user-facing picture; this file is the working contract.

## Layout

| File | Role |
|---|---|
| `src/index.ts`  | bot entry, auth, routing by `message_thread_id` |
| `src/session.ts` | one live SDK session per topic; turn lifecycle |
| `src/claude.ts` | SDK options: model, permission policy, usage accounting |
| `src/tg-tools.ts` | in-process MCP server — the agent's own `send` tool |
| `src/status.ts` | the live status line / turn summary message |
| `src/render.ts` | markdown → topic messages, with format fallback |
| `src/fmt.ts`    | duration & token formatting |
| `src/html.ts`   | markdown → Telegram HTML (fallback when MarkdownV2 fails) |
| `src/cwd.ts`    | `@alias` / `/path` prefix parsing, titles |
| `src/db.ts`     | SQLite state (`node:sqlite`) |
| `src/sweep.ts`  | close/delete idle topics |
| `src/config.ts` | env loading & validation |

## Commands

```bash
npm start          # run
npm run dev        # watch mode
npm run typecheck  # tsc --noEmit — must be clean before you commit
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
- **A topic's session outlives its turns.** `TopicSession` feeds the SDK from an
  iterator that stays open, so an incoming message is delivered at the agent's
  next step — never interrupt a running turn to hand it over, and never add a
  queue in front of it. Anything that shuts a topic down (sweep, idle timeout)
  must go through `endSession`, or the child process is orphaned.
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
