# discordbot-host

Persistent Discord gateway for Quartermaster. Watches two existing channels —
`#woolworths-ordering` and `#order-import` — and spins up a short-lived,
cold, one-shot Claude Code container per message. See the repo root
[CLAUDE.md](../CLAUDE.md) for the full architecture and non-negotiable
constraint (no warm/streaming session ever gets an MCP server registered),
and [DEPLOYMENT.md](../DEPLOYMENT.md) for the NAS deploy target.

Built fresh, not a patch of the old nanoclaw-discord codebase — that was read
on the NAS for reference (the `docker run` stdin/stdout sentinel pattern,
filtered `.env` passthrough, and the reaction-confirm JSON store all trace
back to it) but this drops its multi-group/task-scheduler/IPC-bridge/warm-worker
generality entirely, since this project only ever needs two fixed channels.

## Two channels, two jobs

- **`#woolworths-ordering`** — shopping assistant. Every message triggers a
  cold session with both woolies-mcp and staples-host in its MCP config.
  Direct requests execute immediately; agent-initiated proposals (nudges,
  not something asked for) go through a ✅/❌ reaction-confirm flow. Also
  the posting target for the due/overdue nudges (not yet built),
  auth-failure alert, and "Never tracked" alert.
- **`#order-import`** — manual backfill of past orders into staples-host's
  purchase history. Never spawns a cold session at all — see below. Pure
  data entry: no propose/confirm, matched/unmatched summary relayed straight
  back from staples-host.

Both channels must already exist in the Discord server — discordbot-host
resolves them by name at startup and never creates either.

## Running locally

There's no way to fully exercise this locally: it needs Docker (for
`container/Dockerfile`'s cold-session image and the sibling-container
spawning) and a running Discord server with the two channels, neither of
which is available in this dev environment (no local Docker install — see
the same note in staples-host's README). What was actually verified here:
both TypeScript projects (`discordbot-host` and `container/agent-runner`)
typecheck and build cleanly; the pure `filterNeverTracked` logic and the
container-runner's stdin/stdout protocol were built directly against the
proven nanoclaw-discord pattern. The Docker build, the live Discord gateway
connection, and an actual cold-session round trip all need a real run on
the NAS to verify end-to-end.

```bash
npm install
cp .env.example .env   # fill in DISCORD_BOT_TOKEN, WOOLIES_MCP_URL, STAPLES_HOST_URL, Claude auth
docker build -t discordbot-agent:latest -f container/Dockerfile container
npm run build
npm start
```

On the NAS, both images get built and run there per DEPLOYMENT.md's
workflow — the host image from the repo root Dockerfile, the cold-session
image from `container/Dockerfile`, and the host container needs
`/var/run/docker.sock` mounted in (Docker-outside-of-Docker, same as
nanoclaw-host) to spawn sibling containers on the real daemon.

## Config (env vars)

See `.env.example` for the full list with comments. The two required ones
beyond `DISCORD_BOT_TOKEN` are `WOOLIES_MCP_URL` and `STAPLES_HOST_URL` —
both servers' real HTTP endpoints, registered directly into each cold
session's own MCP config as `type: "http"` servers (no IPC bridge).

Discord bot setup: the bot needs the **Message Content**, **Server Members**,
and **Guild Message Reactions** privileged intents enabled in the Discord
Developer Portal, or `GuildMessages`/`MessageContent`/`GuildMessageReactions`
will silently receive nothing.

## Cold-invocation mechanism

`src/containerRunner.ts` spawns `docker run -i --rm -v ... <image>`, writes
the message as JSON to the container's stdin, and reads a sentinel-marked
JSON result from stdout — `container/agent-runner/src/index.ts` is what
runs inside, making exactly one `query()` call from
`@anthropic-ai/claude-agent-sdk` per invocation and exiting. In practice this
only ever runs for `#woolworths-ordering`; `#order-import` is a pure relay
(see below) and never reaches this code path. Its workspace
(`workspaces/woolworths-ordering/`, containing that channel's `CLAUDE.md`)
and its own `.claude` session directory keep that channel's conversations
and Claude Code session state isolated.

**Why this doesn't hit the non-negotiable constraint's bug:** the container
process runs `query()` exactly once and exits — the failure mode CLAUDE.md
describes is specifically a *warm* session (`query()` + `resume` kept alive
across turns *within one process*) with an MCP server registered. `resume`
across separate cold container invocations (one process each) is the
explicitly-fine case.

## Propose/confirm flow

Decided during this build (see CLAUDE.md): a direct request executes
immediately via native `mcp__woolies__*` tools. When the agent wants to
*propose* something instead (a nudge it initiated), it writes a
`propose-action.json` file (`{ summary, items }`) to its mounted workspace
instead of calling a tool. After the container exits, `src/index.ts` checks
for that file via `takeProposedAction()`; if present, `postAndTrackAction()`
posts it with ✅/❌ reactions and records it in `pending-actions.json`
(`src/pendingActions.ts`), independent of any individual cold call.

Executing on ✅ is a plain host-side MCP call (`set_cart_quantities`) via
`src/mcpClient.ts` — no fresh Claude invocation, since the decision is
already made. ❌ just clears the pending entry and replies "skipped".

## Order-import: thin relay, not a processor

`#order-import` never spawns a cold session at all — for photos *or* text.
`handleOrderImportMessage()` in `src/index.ts` calls one of two plain
host-side MCP relays, both using `src/mcpClient.ts` (the same pattern the
sentries and reaction-confirm execution use):

- **Photos** — `src/orderImportPhotos.ts` reads the downloaded file's bytes,
  base64-encodes them, and calls staples-host's `ingest_receipt`.
- **Text** — `src/orderImportText.ts` passes the raw pasted text straight to
  staples-host's `ingest_order_text` (a new staples-host tool mirroring
  `ingest_receipt`'s design for text instead of a photo).

Both replaced an earlier design where the cold session's own agent did the
work itself, guided by prose instructions in
`workspaces/order-import/CLAUDE.md` (since deleted — there's no cold session
left to read it). The photo version broke under a real local test: a
realistic photo's base64 form runs to roughly 130,000 characters, which the
agent correctly refused to guess at reproducing reliably, and two of three
attempts hung long enough to need force-killing the container. The text
version wasn't broken, exactly, but meant the parsing rules (header-date
extraction, category-line filtering) only existed as this repo's prose,
undermining the same "any front end can trigger identical processing"
principle. Neither ever needed Claude reasoning *in this repo* — the fix in
both cases was recognizing the actual interpretation belongs in
staples-host's own tools, which already do (or now do) their own one-shot
extraction internally.

Verified live end-to-end for both `ingest_order_text` formats against real
staples-host data (confirmed via the database, not just the tool's
response): the full order-confirmation format correctly extracted the
header date and invoice ID; the shorter fallback-date format correctly
resolved "the 3rd" and skipped the category line.

## The two sentries

Both poll directly (no agent involved) and post to `#woolworths-ordering`:

- **`src/wooliesHealthSentry.ts`** — polls woolies-mcp's `auth_status` tool
  every `AUTH_CHECK_INTERVAL_MS` (default 30 min). Alerts only on the
  `true → false` transition, with a repeat at most every
  `AUTH_ALERT_REPEAT_MS` (default daily) while it stays down. State
  persisted in `data/woolies-health-state.json` so a restart doesn't
  re-alert on an already-known failure.
- **`src/neverTrackedSentry.ts`** — polls staples-host's `list_staples`
  every `NEVER_TRACKED_CHECK_INTERVAL_MS` (default 6h), filtered to items
  with `replenishment_interval_days != null` **and** no `last_purchased` —
  the "❔ Never tracked" category, explicitly never "❔ Not enough data yet"
  (no interval at all). The filter checks the interval field directly
  rather than trusting `status: "due"` alone, so it can't silently start
  alerting on no-interval items if `status`'s derivation ever changes in
  staples-host. Only reposts when the filtered set actually changes
  (`data/never-tracked-state.json`). Set `NEVER_TRACKED_TEST_MODE=true` to
  also run one check immediately on startup, to verify without waiting up
  to 6h for real data.

## Known gaps

- The due/overdue nudge into `#woolworths-ordering` mentioned in CLAUDE.md's
  Trigger section isn't built yet — only the auth-failure and Never-tracked
  sentries are.
- No manual `run_staples_order_now`-equivalent test trigger yet (the weekly
  staples-order job itself is still an open item per CLAUDE.md, not
  reintroduced in this build).
- Order-history API sync and its auth-failure surfacing through
  staples-host aren't implemented (blocked on the API fix landing, per
  CLAUDE.md).
