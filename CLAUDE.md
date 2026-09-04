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

**Replenishment logic:** new items start `seeded`, `status = not_due` until ≥2
purchase events exist. At ≥3 events, interval = median gap between purchases
(outlier-resistant), confidence → `learned`. No-interval items never surface as due.

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
