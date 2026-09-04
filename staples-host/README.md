# staples-host

MCP server owning the grocery staples list, purchase-event log, and Craft sync for
Quartermaster. See the repo root [CLAUDE.md](../CLAUDE.md) for the full architecture
and [DEPLOYMENT.md](../DEPLOYMENT.md) for the NAS deploy target.

Exposes 7 MCP tools over Streamable HTTP: `list_staples`, `get_item`,
`record_purchase`, `set_interval`, `sync_from_craft`, `filter_staples`,
`ingest_receipt`.

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
| `CRAFT_API_TOKEN` | for `sync_from_craft` | Craft personal API token, sent as `Authorization: Bearer <token>`. The Connect link alone is **not** sufficient — both are needed. |
| `ANTHROPIC_API_KEY` | for `ingest_receipt` | Used for one-shot Claude vision extraction of receipt photos — a single Messages API call, not an Agent SDK session (see the non-negotiable constraint in CLAUDE.md). |
| `RECEIPT_VISION_MODEL` | no (default `claude-sonnet-5`) | Model used for receipt extraction. |

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
  once it's ≥ `1.5×` interval. That multiplier isn't specified anywhere in the
  brief — it's a tunable constant (`OVERDUE_MULTIPLIER` in `src/config.ts`), not a
  hard requirement.

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

## ingest_receipt

Takes a base64-encoded photo, asks Claude (one Messages API call) to extract line
items as a plain JSON array of names, then fuzzy-matches each against the staples
list and records a `receipt_scan` purchase event per match. Unmatched lines come
back in the response for manual review — nothing is auto-created from a receipt.

## Fuzzy matching

`get_item`, `record_purchase`, `filter_staples`, and `ingest_receipt` fuzzy-match
free-text names (receipt OCR noise, plurals, chat phrasing) against tracked items
via Fuse.js, exact-match first. `sync_from_craft` deliberately does *not* use this
— see above.

## Known open items (not yet resolved — see CLAUDE.md)

- Order-history API sync (`woolies-mcp` → `staples-host`) isn't implemented —
  blocked on the API fix landing.
- Reconciliation between `receipt_scan` and `order_history_api` events isn't
  implemented — the exact matching window (~±2 days per CLAUDE.md) needs
  confirming once both sources exist for real.
