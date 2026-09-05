# staples-host

MCP server owning the grocery staples list, purchase-event log, and Craft sync for
Quartermaster. See the repo root [CLAUDE.md](../CLAUDE.md) for the full architecture
and [DEPLOYMENT.md](../DEPLOYMENT.md) for the NAS deploy target.

Exposes 9 MCP tools over Streamable HTTP: `list_staples`, `get_item`,
`record_purchase`, `set_interval`, `sync_from_craft`, `filter_staples`,
`ingest_receipt`, `ingest_order_text`, `push_status_to_craft`.

## Running locally

```bash
npm install
cp .env.example .env   # then fill in the values below
npm run dev             # tsx watch, http://127.0.0.1:8481/mcp
```

Or via Docker:

```bash
docker build -t staples-host .
docker run -p 8481:8481 --env-file .env -v staples-host-data:/data staples-host
```

The Docker build wasn't tested locally in this environment (no local Docker install)
— per DEPLOYMENT.md's workflow, build and run it for real on the NAS
(`docker build` / `docker compose up` there, not shipped pre-built from the PC).

There's no built-in MCP client UI to click through — the tools were verified during
development with a small script using `@modelcontextprotocol/sdk`'s `Client` +
`StreamableHTTPClientTransport` pointed at `http://127.0.0.1:8481/mcp`. Any MCP
client (Claude.ai custom connector, `mcp-inspector`, etc.) works the same way.

## Config (env vars)

All read from `.env` at startup (or real env vars — `.env` is optional and only
loaded if present). See `.env.example` for the full list with comments:

| Var | Required | Purpose |
|---|---|---|
| `DATA_DIR` | no (default `./data`) | Where `db.json` lives. Point this at the mounted Docker volume path on the NAS. |
| `PORT` | no (default `8481`) | HTTP port. `8480` is taken by woolies-mcp on the NAS. |
| `ALLOWED_HOSTS` | no | Comma-separated hostnames for DNS-rebinding protection. Set to the Tailscale Funnel hostname in production. |
| `CRAFT_CONNECT_URL` | for `sync_from_craft` | Craft Connect share link, from Craft: Settings → Connect/API. Scopes which documents are visible. |
| `CRAFT_STAPLES_DOC_ID` | for `sync_from_craft` | Document ID of the Staples list within that share. Find it via `GET ${CRAFT_CONNECT_URL}/documents`. |
| `CRAFT_API_TOKEN` | for `sync_from_craft`, `push_status_to_craft` | Craft personal API token, sent as `Authorization: Bearer <token>`. The Connect link alone is **not** sufficient — both are needed. This same token covers writes too (confirmed during development — no separate write-scoped token was needed). |
| `CRAFT_STATUS_DOC_ID` | for `push_status_to_craft` | Document ID of the separate "Staples Status" doc. Must already exist — create it manually in Craft first; this server never creates docs. |
| `ANTHROPIC_API_KEY` | for `ingest_receipt`, `ingest_order_text` | Used for one-shot Claude extraction (vision for receipts, text for pasted orders) — a single Messages API call per tool call, not an Agent SDK session (see the non-negotiable constraint in CLAUDE.md). A Claude Code OAuth token (`sk-ant-oat01-...`, e.g. from `claude setup-token`) is **not** a substitute — confirmed by testing, it fails with `401 API key is invalid` against the direct Messages API. Needs a real key from console.anthropic.com (`sk-ant-api03-...`). |
| `EXTRACTION_MODEL` | no (default `claude-sonnet-5`) | Model used for both extraction tools. |

Tools that need config they don't have return a clear `isError` result explaining
what's missing, rather than crashing the server.

## Storage

Flat JSON file (`$DATA_DIR/db.json`) holding `items` and `purchase_events`, written
atomically (write-temp-then-rename) with an in-process write queue serializing
concurrent tool calls. No baked-in state — the volume is the only thing that needs
to move if this migrates off the NAS later. Move to SQLite in the same volume if
reconciliation ever needs real queries (per CLAUDE.md) — not needed yet.

## Replenishment logic

- New items start `interval_confidence: seeded`, `status: not_due`.
- Status is only ever evaluated once an item has **2+ purchase events** — below
  that there's no purchase history to anchor a due date against.
- At **3+ events**, `replenishment_interval_days` is recomputed as the median gap
  between consecutive purchases (outlier-resistant) and `interval_confidence`
  flips to `learned` — this happens automatically on every `record_purchase`, and
  overrides any earlier manual `set_interval` value once there's enough real data.
- Items with no interval (not enough data yet) never surface as due.
- `due` vs `overdue` split: `due` once days-since-purchase ≥ interval, `overdue`
  once it's ≥ `1.5×` interval (`OVERDUE_MULTIPLIER` in `src/config.ts`, confirmed
  against CLAUDE.md).
- **Exception — `set_interval`'s anchor date.** The 2+ event gate above only
  applies to the organic, purchase-event-driven path
  (`recomputeItemSummary`/`computeStatus`). `set_interval(item_name, days,
  last_purchased?)` computes status straight from (interval, last_purchased) via
  `computeStatusFromAnchor`, no event count involved:
  - `last_purchased` given → due/overdue math runs immediately, same as a
    learned item. `last_purchased_source` becomes `manual_seed`; a real
    purchase recorded afterward overwrites it as usual.
  - `last_purchased` omitted and the item has no existing anchor → `status:
    "due"` right away rather than `not_due`/"not enough data" — a seeded
    interval with nothing to anchor it shouldn't sit silent.
  - `last_purchased` omitted but a real anchor already exists (from prior
    purchase events) → that existing date is used.

## Craft sync

`sync_from_craft` reads the Staples doc's direct child blocks and treats every
non-empty one as an item name (the real doc turned out to be plain paragraph
lines, not an actual bullet-styled list — the parser tolerates both, stripping
markdown list/emphasis syntax either way). Matching against existing items is
**exact** (case-insensitive), not fuzzy — Craft is the source of truth for what
items exist, so a near-miss should create a new item rather than silently merge
into an existing one.

Sync is **add-only**: it never removes or modifies existing items, even ones
Craft no longer lists. CLAUDE.md's requirement is only that purchase history is
never dropped; full two-way reconciliation (removing items that vanished from
Craft) wasn't implemented since it risks discarding data on a false-negative
parse, and wasn't asked for.

## push_status_to_craft

Writes current status to a **separate, bot-owned** "Staples Status" Craft doc
(never the source doc `sync_from_craft` reads from — that'd create a pull/push
loop). Wholesale overwrite every call: delete every existing top-level block in
the doc, then write fresh ones — no diff/merge, since the doc is never meant to
be hand-edited. Verified idempotent (repeated pushes produce the same block
count, no accumulation).

Items are grouped by urgency (Overdue / Due soon / Stocked / Never tracked /
Not enough data yet) per CLAUDE.md's exact template, sorted alphabetically
within each group. Empty groups are omitted entirely rather than shown with no
items under them — not specified in the brief, chosen for a cleaner
at-a-glance read (confirmed against CLAUDE.md as the intended behavior).

Grouping logic, in order:
1. `replenishment_interval_days == null` → **Not enough data yet** (no
   interval at all, neither seeded nor learned).
2. Interval set but `last_purchased == null` → **Never tracked** — a
   `set_interval`-seeded item with no anchor date. `computeStatusFromAnchor`
   already resolves this to `status: "due"`, but it's kept visually separate
   from genuinely-computed "Due soon"/"Overdue" items since there's no real
   purchase date behind it. Line format:
   `- <item> — no purchase on record yet (usually every ~<interval> days)`.
3. Otherwise, `item.status` decides Overdue / Due soon / Stocked directly,
   with the normal line format:
   `- <item> — last bought <N> days ago (usually every ~<interval> days)`.

See the Replenishment logic section above for how `status` gets set.

**Craft's write API isn't in the public docs** (the docs site is a client-side
app my fetch tools can't render) — the request/response shapes below were
reverse-engineered from the live API's Zod validation error messages:

- Create blocks: `POST {CRAFT_CONNECT_URL}/blocks?id=<pageId>` with body
  `{"blocks": [{"type": "text", "markdown": "..."}], "position": {"position": "end", "pageId": "<pageId>"}}`
- Delete blocks: `DELETE {CRAFT_CONNECT_URL}/blocks?id=<pageId>` with body
  `{"blockIds": ["...", "..."]}`
- The existing read-scoped `CRAFT_API_TOKEN` already covers both — no separate
  write token or elevated scope was needed when this was tested.

## ingest_receipt

Takes a base64-encoded photo, asks Claude (one Messages API call) to extract line
items as a plain JSON array of names, then fuzzy-matches each against the staples
list and records a `receipt_scan` purchase event per match. Unmatched lines come
back in the response for manual review — nothing is auto-created from a receipt.

## ingest_order_text

`ingest_order_text(text, date?, raw_ref?)` mirrors `ingest_receipt` for pasted
order-confirmation/order-list text instead of a photo. Built specifically to
close a "thin relay" architecture gap in discordbot-host's `#order-import`
channel: that logic used to live as prose in discordbot-host's own workspace
config (interpreted by a cold Claude session before calling `record_purchase`
per line), which meant the identical capability wasn't triggerable from any
other front end without also copying that prose. Now it's one self-contained
tool, same as `ingest_receipt`.

One Messages API call extracts, in priority order: (1) a date and invoice ID
from an `Order Confirmation/Invoice Number <ID> <DD Mon, YYYY>` header if
present, (2) otherwise a date stated informally in the text (e.g. "bought this
on the 3rd"), resolved relative to today, (3) otherwise `null` (the tool then
defaults to today). Category/section header lines (no leading ref number) are
filtered out as not-items. Each remaining line is fuzzy-matched and recorded
exactly like `ingest_receipt`'s per-line loop — same `receipt_scan` source,
same matched/unmatched response shape. The extracted invoice ID (or the
caller's `raw_ref`, or the line text itself) becomes each event's `raw_ref`.

Verified live against real data for both real-world formats: the full
header'd format correctly extracted the header date and invoice number; a
shorter, header-less paste with an informal "bought this on the 3rd" correctly
resolved to the current month. Confirmed independently callable — a plain
Claude.ai conversation with this server as a custom connector could paste the
same text and call this tool directly, identical result, no other code
involved.

`AnthropicNotConfiguredError` (in `src/anthropicClient.ts`) is shared between
this tool and `ingest_receipt` — both need `ANTHROPIC_API_KEY`, and generalizing
the error (it used to be named/worded for vision specifically) avoided a
second near-duplicate class.

## Fuzzy matching

`get_item`, `record_purchase`, `filter_staples`, `ingest_receipt`, and
`ingest_order_text` fuzzy-match free-text names (receipt OCR noise, plurals,
chat phrasing) against tracked items via Fuse.js, exact-match first.
`sync_from_craft` deliberately does *not* use this — see above.

## Known open items (not yet resolved — see CLAUDE.md)

- Order-history API sync (`woolies-mcp` → `staples-host`) isn't implemented —
  blocked on the API fix landing.
- Reconciliation between `receipt_scan` and `order_history_api` events isn't
  implemented — the exact matching window (~±2 days per CLAUDE.md) needs
  confirming once both sources exist for real.
