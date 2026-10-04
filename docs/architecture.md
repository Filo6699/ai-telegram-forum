# Architecture

The broker has two entry paths: Telegram updates start or resume a topic session;
the adoption CLI binds an existing native session to a topic. Both use the same
configuration and topic database. Public npm commands remain the entry points
for running, watching, installing integrations, and adopting sessions.

```text
src/index.ts → app/bot.ts → sessions/topic.ts → sessions/factory.ts
                                 │                    │
                                 │             providers/{claude,codex,openrouter}/session.ts
                                 │                    │
                                 └──── telegram/ ─────┘

cli/telegramify.ts → storage/db.ts + app/heartbeat.ts + Telegram API
```

## Responsibilities

- `app/` composes the bot: authentication, command handlers, launch flow, input
  routing, heartbeat and topic cleanup. It owns access to live topic sessions.
- `sessions/topic.ts` owns the provider-independent topic lifecycle: idle timers,
  turn status, delivery fallback, settings and persisted usage. `types.ts` defines
  the runner contract; `factory.ts` selects the provider implementation.
  `usage.ts` and `limits.ts` hold common accounting data, without provider logic.
- `providers/` owns protocol details. Each provider implements the same session
  contract in its own `session.ts`. Claude keeps its SDK input iterator open;
  Codex manages app-server threads and side forks; OpenRouter manages its request
  loop, tools and history. Accounting and native transport helpers stay beside
  the provider that uses them.
- `telegram/` owns Telegram interaction: parsing commands, choosing settings,
  approval buttons, collecting attachments, rendering messages and sending agent
  output. `limits.ts` formats common plan-limit data; it does not fetch it.
- `config/` parses environment and settings and describes model/effort/preset
  choices. It does not start agent processes or write topic state.
- `storage/` owns SQLite persistence. OpenRouter transcript persistence stays
  with its provider because it is part of that provider's session protocol.
- `cli/` owns adoption and integration installation. Adoption points to an
  existing session; it never copies or rewrites its transcript.
- `shared/` contains small pure helpers that have no application dependencies.

## Dependency boundaries

Provider runners import the contracts from `sessions/types.ts`, never from the
factory or topic manager. Only the factory selects concrete runners. Provider
implementations do not import one another; common data belongs in `sessions/`.
A native Claude `Query` remains part of the control contract for `/usage` and
`/btw`, so this is an internal application boundary, not a standalone SDK.

`app/` and `cli/` are composition roots. Lower-level modules must not import bot
startup code. The adoption CLI uses the heartbeat reader without starting the
bot. The Claude limit reader receives a live control channel from the caller;
it does not discover topic sessions itself.

Telegram helpers and providers may use configuration and storage. Configuration
may use picker *types*, but must not depend on running Telegram interactions.
Use direct imports to the owning module; avoid barrel exports that hide startup
side effects such as opening SQLite or starting polling.

## Adding or moving code

Put new provider transport, tools and session behavior in that provider's folder.
Add shared lifecycle behavior to `sessions/`, Telegram presentation to
`telegram/`, and routing in `app/`. A new provider implements `AgentSession` and
is wired through the factory, provider settings and launch choices.

The bot entry remains `src/index.ts`; `src/codex-tg-server.ts` is the stable MCP
subprocess entry, also used by broker sessions started before this reorganization.
CLI entry paths are declared in
`package.json`; installed integrations invoke npm scripts rather than internal
source files. File-relative paths for the Codex executable, its Telegram MCP
server and the command installer's repository root must be updated when moving
those files. The entry-point tests exercise MCP startup and installation from a
foreign working directory, where incorrect relative paths are easy to miss.

Run `npm run typecheck` and `npm test` after changes. Keep runtime behavior,
Telegram callback authorization and append-only transcript guarantees intact
when changing module boundaries.
