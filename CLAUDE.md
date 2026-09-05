# Quartermaster

Household-ops assistant: a Discord bot + a set of MCP servers that manage grocery
staples and Woolworths NZ ordering. This file is the project brief for Claude Code —
read it fully before making changes.

## Warm sessions: allowed, but scoped and built to a specific checklist

Earlier revisions of this file flatly prohibited any warm/streaming Claude Agent
SDK session (`query()` + `resume` kept alive across turns) that had an MCP server
registered, believing it hung indefinitely as an unfixable upstream Agent SDK
defect — reproduced with zero woolies tools, a purely local in-process MCP server,
across ~130 SDK versions. A related project (nanoclaw-discord) ran that investigation
to ground: it was two fixable bugs in *application* code, not the SDK —

1. A health check that polled for warm-worker health without ever delivering a
   prompt first, structurally guaranteed to hang (this alone explains the
   ~130-version, zero-MCP-tools reproduction: a check that can never pass fails
   the same way regardless of SDK version or tool config).
2. An MCP-call bridge timeout (20s) too short for a fresh connection handshake
   under real network conditions — only surfaced once bug 1 was fixed.

**Any warm/streaming session built in this project must satisfy every item below.**
The default everywhere is still cold, one-shot sessions (`--resume <id>` across
separate cold calls, not a kept-alive process) — warm mode is an explicit,
per-channel/group opt-in, never a fleet-wide switch:

- **Health checks always deliver a real (or lightweight synthetic) prompt before
  checking session health.** Never wait on a signal like `system`/`init` alone —
  the SDK's streaming-input generator only produces messages in response to
  something written to the async-iterable it's blocked reading from.
- **Timeouts sized generously from observed latency, not arbitrary defaults** —
  in particular, MCP tool calls that establish a fresh connection (e.g. to
  woolies-mcp or staples-host) need a timeout comfortably above realistic
  real-world API round-trip time. nanoclaw's own bridge started at 20s and had
  to be bumped to 35s after a real failure; don't re-derive that the hard way —
  start at 35-45s for any first-call-after-restart scenario.
- **Full custom-tool surface allowed, including MCP servers** — no need to strip
  MCP registration from a warm session or build a separate zero-MCP bridge
  architecture; that was a real but unnecessary workaround built before the
  actual bug was found.
- **Scoped per channel/group behind an explicit config flag**, defaulting to
  off, mirroring nanoclaw's `containerConfig.persistentWorker` pattern — so a
  real, previously-unseen issue can be isolated to one channel instead of
  forcing an all-or-nothing rollback.
- **Restart/staleness-recovery paths follow the same deliver-a-prompt-then-check-health
  pattern** as the initial health check, and should be deliberately exercised
  against their real trigger condition once live, not just a manual one-off test —
  that's specifically what caught bug 1 in nanoclaw.

discordbot-host's `#woolworths-ordering` channel is the only place this is built
out so far (`src/warmSession.ts`, `src/agentDispatch.ts`), and only synthetic/
manual-triggered so far — no real Discord traffic has exercised it yet. See that
package's README "Warm mode" section for the full detail and what's still
unproven; `src/warmSession.ts`'s file header maps each checklist item above to
exactly where it's implemented.

## Architecture

Three plain Docker containers. All default to cold, one-shot Claude Code
invocations; `discordbot-host` alone can optionally run a warm session for
`#woolworths-ordering`, off by default (see above):

### 1. woolies-mcp (reuse, do not modify)
Already deployed and working. Owns Woolworths NZ login and all cart/order actions.
Docker container on the NAS, Tailscale Funnel on port 8480, registered as a Claude.ai
custom connector. Treat as an external dependency — this repo does not contain or
rebuild it.

### 2. staples-host (new build — MCP server)
Same deployment pattern as woolies-mcp: own container, own port, own Tailscale
Funnel endpoint, own Claude.ai connector registration. Reachable identically by
discordbot-host's cold sessions and by Claude mobile/desktop directly.

**Storage:** all state (staples list, purchase-event log) in a Docker volume
outside the image, not baked in — so it migrates to a VPS later via directory copy.
Start with JSON; move to SQLite in the same volume if reconciliation needs real
queries. Only staples-host touches this volume.

**Ownership boundaries:**
- staples-host owns the full Craft sync end-to-end. Nothing else talks to Craft.
- staples-host calls woolies-mcp directly for order-history sync (once Adrian's API
  fix lands) — no lifted/duplicated Woolworths API logic.
- The Woolworths auth token never leaves woolies-mcp.

**Data model:**
- `items`: item_id, name, sku (cached, self-heals via woolies-mcp `search_products`
  if stale), replenishment_interval_days (null until enough data), interval_confidence
  (`seeded` | `learned`), status (`not_due` | `due` | `overdue`, default `not_due`)
- `purchase_events` (append-only): event_id, item_id, date, source (`receipt_scan` |
  `order_history_api`), raw_ref
- `items.last_purchased` / `last_purchased_source`: denormalized, derived from
  `purchase_events`

**MCP tools:**
- `list_staples()`
- `get_item(name)`
- `record_purchase(item_name, date, source, raw_ref?)` — fuzzy-match, append event,
  update summary
- `filter_staples(ingredients: string[])` — which ingredients aren't already-stocked
- `ingest_receipt(image)` — vision extraction → fuzzy-match → `record_purchase` per
  line, return unmatched lines
- `ingest_order_text(text, date?, raw_ref?)` — mirrors `ingest_receipt` for pasted
  order-confirmation/order-list text instead of a photo: one-shot text extraction
  (header date + invoice ID, or a stated date, or today) → fuzzy-match → record
  per line, return matched/unmatched. Built to close discordbot-host's
  `#order-import` text-parsing gap — see that section for detail.
- `set_interval(item_name, days)` — manual override
- `sync_from_craft()` — pull Staples list from Craft; add new items, never drop
  items with purchase history
- `push_status_to_craft()` — write current status (name, due/overdue/not_due,
  last_purchased, interval) to a **separate, bot-owned Craft doc named "Staples
  Status"** — created manually by the user first (Craft's write API likely needs
  an existing doc ID/target, not create-and-write in one call), used purely for
  visual reference. Not the source Staples doc `sync_from_craft()` reads from —
  this avoids a pull/push loop: `sync_from_craft()` never reads this doc, and it
  can be safely overwritten wholesale on every push (no diff/merge against user
  edits needed, since the user isn't expected to hand-edit it).

  **Format** — grouped by urgency, not alphabetical, with a last-updated
  timestamp and each item showing its current interval ("usually every ~X days")
  alongside days since last purchase:
  ```
  Quartermaster — Staples Status
  Last updated: <timestamp>

  ⚠️ Overdue
  - <item> — last bought <N> days ago (usually every ~<interval> days)

  🟡 Due soon
  - <item> — last bought <N> days ago (usually every ~<interval> days)

  ✅ Stocked
  - <item> — last bought <N> days ago (usually every ~<interval> days)

  ❔ Never tracked
  - <item> — no purchase on record yet (usually every ~<interval> days)

  ❔ Not enough data yet
  - <item> — no interval learned yet
  ```
  Items seeded via `set_interval` with no `last_purchased` anchor (`status: due`
  but no real date to compute from) get their own **"❔ Never tracked"** section —
  kept visually separate from genuinely-computed "Due soon"/"Overdue" items, not
  folded into either. Distinct from **"❔ Not enough data yet"**, which is for items
  with no interval at all (neither seeded nor learned).

  Confirm Craft's write API/token scope before implementing — the existing
  `CRAFT_API_TOKEN` may need broader permissions than the read-only pull required.

**Replenishment logic:** new items start `seeded`, `status = not_due` until ≥2
purchase events exist. At ≥3 events, interval = median gap between purchases
(outlier-resistant), confidence → `learned`. No-interval items never surface as due.
Status thresholds: `not_due` while `days_since_last_purchased < interval`; `due`
once `days_since_last_purchased >= interval`; `overdue` once
`days_since_last_purchased >= interval * OVERDUE_MULTIPLIER`. `OVERDUE_MULTIPLIER`
was introduced during the build as a tunable constant (not specified in this brief)
— confirm its actual configured value, since it controls how much slack an item
gets before escalating from a soft "due" nudge to an "overdue" alert.

**Reconciliation (once order-history API is fixed):** both sources tag events with
`source` from day one. Match `receipt_scan` and `order_history_api` events for the
same item within ~±2 days, merge, treat API as authoritative when both exist.
Unmatched API events fill gaps, not duplicates.

### 3. discordbot-host (rebuild — replaces nanoclaw-host)
Keep only what a cold, one-shot-per-message architecture needs. This is now a
fresh build against a real, already-deployed staples-host, not a plan against
a hypothetical one — reference the old nanoclaw-discord code only where the
Keep list below says to; don't patch it.

**Trigger — channel-scoped, not keyword-based.** Any message in either of two
existing Discord channels triggers a cold invocation automatically — no
`!nano`-style prefix. Both channels already exist; discordbot-host only ever
references them by name (resolved to channel IDs at startup by searching the
guild's channels), never creates either.

- **`#woolworths-ordering`** — the single home for **all** action-oriented
  output: user shopping requests, staples-host due/overdue nudges, the
  auth-failure alert, and the "Never tracked" alert all post here, since
  acting on any of them routes through woolies-mcp. Cold sessions here get
  both woolies-mcp and staples-host in their MCP config.
- **`#order-import`** — manual backfill of *past* orders into staples-host's
  purchase history. Distinct from the future automatic order-history API
  sync (not yet implemented) — this is a second, human-driven way historical
  purchases get recorded. Pure data entry, not a cart action: messages/
  photos posted here route straight to staples-host's `ingest_order_text`
  (text) or `ingest_receipt` (photos) and execute immediately — **no**
  propose/confirm flow, no ✅/❌ reaction.

  **Architecture principle, confirmed and fully closed by audit:**
  discordbot-host is a thin relay for this channel, never the processor —
  **no cold session is ever spawned for `#order-import` at all**, for either
  photos or text. All receipt/order-processing logic (vision extraction,
  text extraction, fuzzy-matching, recording, `last_purchased` updates)
  lives entirely in staples-host's own tools, so the identical capability
  stays triggerable from any other front end (Claude mobile/desktop, a
  future web UI) via the same staples-host tool, with zero discordbot-host
  code in the path — confirmed for both modalities, not just photos.
  - **Photos** relay to `ingest_receipt`: discordbot-host downloads the
    attachment, base64-encodes it itself, and calls the tool via a plain
    host-side MCP call (the same pattern the sentries and reaction-confirm
    execution use) — no agent, no container spawned. Replaces an earlier
    design where the cold session's own agent was instructed to
    base64-encode the file via Bash and construct the tool call itself; that
    broke in practice (a realistic ~130,000-character base64 string isn't
    something an agent can reliably read back to build a tool call from, and
    two of three test attempts hung long enough to need force-killing).
  - **Text** relays to `ingest_order_text` (new tool, mirrors
    `ingest_receipt`'s design): discordbot-host passes the raw pasted text
    straight through via the same plain host-side MCP call pattern — no
    agent parsing it first. Replaces an earlier design where the cold
    session's own agent, guided by prose instructions in discordbot-host's
    workspace `CLAUDE.md`, did the parsing itself before calling
    `record_purchase` per line — that file has been deleted now that the
    real tool exists, so there's exactly one source of truth for this logic.
  - `ingest_order_text(text, date?, raw_ref?)`'s own one-shot extraction
    (its own internal Anthropic API call, same non-agent pattern as
    `ingest_receipt`'s vision call) does what the deleted prose used to
    describe: extract the date from an `Order Confirmation/Invoice Number
    <ID> <DD Mon, YYYY>` header when present (along with the invoice ID, used
    as `raw_ref`), falling back to a date stated informally elsewhere in the
    text (e.g. "bought this on the 3rd") or to today; skip category/section
    header lines (no leading ref number); fuzzy-match each remaining item
    line against the staples list and record a purchase event per match with
    `source: "receipt_scan"`, returning matched/unmatched in the same shape
    `ingest_receipt` already uses. A failed match is reported as unmatched,
    never silently dropped and never used to auto-create a new staple.
  - Verified live end-to-end against real test data for both formats: the
    full order-confirmation format correctly extracted the header date and
    invoice ID and recorded the matched items (confirmed via staples-host's
    own data, not just the tool's response); the shorter fallback-date
    format correctly resolved "the 3rd" to the current month and skipped the
    category line. Confirmed independently callable, for both photos and
    text: a plain Claude.ai conversation with a staples-tracker-mcp
    connector could share the same photo or paste the same text and call
    `ingest_receipt` / `ingest_order_text` directly, identical result, zero
    discordbot-host involvement.
  - **`source` is reused as `"receipt_scan"`**, not a new source value —
    a backfilled order is, for reconciliation purposes, the same kind of
    human-provided evidence a photographed receipt is (as opposed to
    authoritative API data), and adding a new value would mean reopening
    staples-host's already-built, already-deployed data model for something
    this channel doesn't actually need. Not asked for here, so not done.

**Keep:**
- Persistent Node process holding the Discord gateway open, listening for
  messages/reactions in `#woolworths-ordering` and `#order-import`
- Spinning up a short-lived sibling container per message (mounted Docker CLI +
  `/var/run/docker.sock`) to run one cold Claude Code invocation — in practice
  only ever for `#woolworths-ordering`; `#order-import` is a pure relay and
  never reaches a cold session at all, see that section
- Passing woolies-mcp and staples-host into each cold session's own MCP config
  as remote `type: "http"` servers (fine in cold mode — this is not the bug
  path), so the agent calls them as native `mcp__woolies__*` / `mcp__staples__*`
  tools — no IPC bridge in between.
- Reaction-confirm mechanism, entirely in the persistent process, independent of
  any individual cold call: post ✅/❌ (or 👍/👎) on proposed actions; a
  pending-actions store (JSON/SQLite, keyed by Discord message ID, supports
  multiple simultaneous pending actions); execute + confirm on ✅, reply "skipped" +
  clear on ❌. Requires `GuildMessageReactions` intent and
  `Partials.Message/Reaction/Channel` so reactions survive restarts.
  - **How a proposal is initiated**, decided during this build: a direct
    request ("add milk") gets executed immediately by the agent via native
    woolies tools — no proposal needed. When the agent decides to *propose*
    rather than act (a nudge it initiated, not something asked for this
    message), it writes a `propose-action.json` file to its mounted workspace
    (`{ summary: string, items: [{ name, sku, quantity, pricingUnit }] }`)
    instead of calling any tool. After each cold run exits, the host checks
    for that file; if present, it does the actual posting +
    reaction-tracking itself (independent of the container, per the bullet
    above), then deletes it. Same convention for the due/overdue and
    never-tracked nudges below — whatever writes the proposal, one host-side
    code path turns it into a tracked ✅/❌ post.
  - **Executing on ✅** is a plain host-side function, not a fresh Claude
    invocation: a direct MCP client call to woolies-mcp's
    `set_cart_quantities`, using the pending entry's already-resolved SKUs/
    quantities. No agent needs to be in the loop to apply a decision that's
    already been made.
- Session-ID resumption for conversation continuity across separate cold calls
  (save session ID, pass `--resume <id>` next time) — new addition, not in the old
  code, build it in from the start.
- **Woolworths auth-failure alerting.** Detection mechanism decided during this
  build: a periodic (every 30 min) direct host-side call to woolies-mcp's
  `auth_status` tool — no agent involved. Confirmed live shape: `{
  accountToolsUsable: boolean, cookieExpiresAt?: string, hint: string }`.
  Alert only on the `true → false` transition (not every poll while still
  down), with a daily repeat while it stays down so it doesn't scroll off
  unnoticed. Alert text confirmed still accurate against the real woolies-mcp
  source (`npm run login -- --server <url>` → `scripts/login.ts`, which still
  takes `--server <url>` exactly as documented): `Woolworths session is dead.
  Fix it from your PC: npm run login -- --server <woolies-mcp Funnel URL>`.
  Also applies to staples-host's order-history sync calls to woolies-mcp
  (not yet implemented) — an auth failure there must be surfaced the same
  way, not silently treated as "no orders in this period" (which would
  corrupt the replenishment-interval data).
- **"Never tracked" item alerting.** Now buildable — staples-host is real.
  Mechanism: a periodic (every 6h) direct host-side call to staples-host's
  `list_staples()`, filtered to items with an interval set (seeded or
  learned) **and** no `last_purchased` anchor — exactly the "❔ Never tracked"
  category from the Craft doc, never "❔ Not enough data yet" (no interval at
  all, neither seeded nor learned). The filter checks
  `replenishment_interval_days != null` explicitly rather than trusting
  `status: "due"` alone to imply it — a defensive check against the
  no-interval/no-alert guarantee silently breaking if `status`'s derivation
  ever changes elsewhere. No-interval items must never trigger a Discord
  alert under **any** sentry (this one or a future due/overdue one) — the
  same "stay silent until there's a real basis to flag something" goal the
  replenishment logic itself was built around. No agent involved in the poll.
  Posted as its own distinct message, not folded into the auth-failure alert
  or into cart proposals. Only reposts when the filtered item set actually
  changed since the last post, so it doesn't repeat itself every 6 hours for
  no reason. A test-only bypass (env var or manual trigger) lets this be
  verified on demand instead of waiting up to 6h for real data — the bypass
  only shortcuts *when* the check runs, never the no-interval exclusion
  itself.

**Drop:**
- The old nanoclaw-discord warm/streaming session code path specifically —
  it carried the two bugs described in "Warm sessions" above. Don't patch or
  reuse it; discordbot-host's own warm-session path (`src/warmSession.ts`,
  opt-in, off by default) was built fresh against that checklist instead.
- The old local IPC MCP server used to route custom tools into a warm session —
  move tools either into the cold session's own MCP config, or into discordbot-host
  as plain host-side functions if they don't actually need Claude in the loop
- The standalone woolies-bridge test process — it proved the diagnosis, was never
  meant to ship
- The disabled `staples-order.ts` weekly job — use for reference only, rebuild
  against staples-host's real MCP interface; keep a manual
  `run_staples_order_now`-equivalent for testing

**Latency:** ~1.5 min/message is the accepted cost of staying cold with the full
tool surface intact, and remains the default everywhere. Not a target to optimize
away by itself — but if `#woolworths-ordering` is switched to warm mode (see
"Warm sessions" above), expect roughly 9-61s/message instead once a warm session
is up, per nanoclaw's own measurements with the bugs fixed.

**Concurrency model — one cold session per channel at a time, always.** The
"~1.5 min/message" figure above assumes messages are handled one at a time;
nothing enforced that until this was hit during the initial NAS deployment —
3 messages arriving within 5 seconds spawned 3 concurrent cold sessions,
which thrashed the NAS's limited RAM into swap and all 3 timed out without a
single reply. `discordbot-host/src/index.ts`'s `enqueueChannelTurn` now
queues the full agent turn (session-ID read, container run, session-ID save,
reply, proposal posting) per channel — a later message always waits for the
one ahead of it to fully finish before its own cold session spawns. This is
purely a serialization fix, not a capacity fix: it does not make the NAS
faster or add RAM, it only stops concurrent sessions from competing for the
RAM it has. A burst of messages during a period of otherwise-high NAS load
should still be expected to take *longer* in total than usual — each queued
turn waits for the last, and the NAS may still be slow for other reasons —
not faster, and not a guarantee every burst completes within any particular
time budget.

## Open items to confirm before/during build
- Shape of the fixed order-history API (fields, pagination, date format) — gates
  staples-host's order-history calls and the reconciliation pass
- Exact reconciliation window/logic once both purchase-event sources exist for real
- Whether any host-side actions currently done via the old IPC tools genuinely need
  Claude in the loop, or can just be discordbot-host functions
