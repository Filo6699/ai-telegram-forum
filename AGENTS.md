# AGENTS.md

Telegram forum ↔ Claude Code broker. One forum topic = one Agent SDK session.
Read `README.md` for the user-facing picture; this file is the working contract.

## Layout

| File | Role |
|---|---|
| `src/index.ts`  | bot entry, auth, routing by `message_thread_id` |
| `src/claude.ts` | one turn via the Agent SDK |
| `src/render.ts` | posts a finished turn to a topic |
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

- **Never send partial output to Telegram.** A turn is posted once, when it is
  complete. No streaming edits, no placeholder messages — an empty turn sends
  nothing at all.
- Take assistant text from the final `assistant` messages, not from partial
  stream events; keep `result.result` as the fallback. Losing a reply that the
  session recorded is the bug this design exists to prevent.
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
