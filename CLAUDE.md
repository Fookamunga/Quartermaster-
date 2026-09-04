# Quartermaster

Household-ops assistant: a Discord bot + a set of MCP servers that manage grocery
staples and Woolworths NZ ordering. This file is the project brief for Claude Code —
read it fully before making changes.

## Non-negotiable constraint

**Never build a warm/streaming Claude Agent SDK session (`query()` + `resume` kept
alive across turns) that has any MCP server registered in its own startup config.**
This hangs indefinitely — confirmed as an upstream Agent SDK defect, reproduced with
zero woolies tools, a purely local in-process MCP server, and across ~130 SDK
versions (0.2.29 → 0.3.260). Not fixable from our side. Every Claude Code invocation
in this project must be a **cold, one-shot session** (`--resume <id>` for
conversation continuity across separate cold calls is fine — that's not the same
thing as keeping one session process alive).

## Architecture

Three plain Docker containers, none running the Agent SDK's warm mode:

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
Keep only what a cold, one-shot-per-message architecture needs:

**Keep:**
- Persistent Node process holding the Discord gateway open, listening for
  messages/reactions
- Spinning up a short-lived sibling container per message (mounted Docker CLI +
  `/var/run/docker.sock`) to run one cold Claude Code invocation
- Passing woolies-mcp and staples-host into each cold session's own MCP config
  (fine in cold mode — this is not the bug path)
- Reaction-confirm mechanism, entirely in the persistent process, independent of
  any individual cold call: post ✅/❌ (or 👍/👎) on proposed actions; a
  pending-actions store (JSON/SQLite, keyed by Discord message ID, supports
  multiple simultaneous pending actions); execute + confirm on ✅, reply "skipped" +
  clear on ❌. Requires `GuildMessageReactions` intent and
  `Partials.Message/Reaction/Channel` so reactions survive restarts.
- Session-ID resumption for conversation continuity across separate cold calls
  (save session ID, pass `--resume <id>` next time) — new addition, not in the old
  code, build it in from the start.
- **Woolworths auth-failure alerting.** The existing bot (posting under the
  Discord identity "Claude_BotAPP") already detects when woolies-mcp's Woolworths
  session has died and posts an alert instructing manual re-login, e.g.:
  `Woolworths session is dead. Fix it from your PC: npm run login -- --server
  <woolies-mcp Funnel URL>`. This is host-side detection/alerting logic, not
  something woolies-mcp does itself — woolies-mcp just fails normally (an
  auth-failure response) when its session is dead. Preserve this behavior in the
  rebuild: discordbot-host should distinguish "woolies-mcp says auth failed" from
  other failure modes and post this same kind of alert. Also applies to
  staples-host's order-history sync calls to woolies-mcp — an auth failure there
  must be surfaced the same way, not silently treated as "no orders in this
  period" (which would corrupt the replenishment-interval data). Confirm the
  `npm run login -- --server <url>` re-auth flow still works unchanged post-rebuild
  before assuming the alert text is still accurate.
- **"Never tracked" item alerting.** A separate, standing Discord message/alert for
  items that are seeded (via `set_interval`) but have no `last_purchased` anchor —
  same underlying data as the Craft doc's "❔ Never tracked" section, but as its own
  distinct Discord post, not folded into any other alert. Call staples-host's
  `list_staples()` (or equivalent), filter for no-anchor seeded items, and post
  them separately. Not buildable until this phase starts.

**Drop:**
- Any warm/streaming session code path — nothing should keep a Claude session
  process alive between messages
- The old local IPC MCP server used to route custom tools into a warm session —
  move tools either into the cold session's own MCP config, or into discordbot-host
  as plain host-side functions if they don't actually need Claude in the loop
- The standalone woolies-bridge test process — it proved the diagnosis, was never
  meant to ship
- The disabled `staples-order.ts` weekly job — use for reference only, rebuild
  against staples-host's real MCP interface; keep a manual
  `run_staples_order_now`-equivalent for testing

**Latency:** ~1.5 min/message is the accepted cost of staying cold with the full
tool surface intact. Not a target to optimize away.

## Open items to confirm before/during build
- Shape of the fixed order-history API (fields, pagination, date format) — gates
  staples-host's order-history calls and the reconciliation pass
- Exact reconciliation window/logic once both purchase-event sources exist for real
- Whether any host-side actions currently done via the old IPC tools genuinely need
  Claude in the loop, or can just be discordbot-host functions
