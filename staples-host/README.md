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
| `EXTRACTION_MAX_TOKENS` | no (default `4096`) | Output budget for both extraction tools. See "Extraction failure modes" below for why this isn't 1024. |
| `WOOLIES_MCP_URL` | for `suggest_alternatives` | woolies-mcp's own MCP endpoint, used only to re-resolve a historical `product_name` to a live product — staples-host's one narrow, read-only exception to never calling woolies-mcp itself (see CLAUDE.md's Ownership boundaries). |

Tools that need config they don't have return a clear `isError` result explaining
what's missing, rather than crashing the server — except `suggest_alternatives`,
which deliberately returns an empty `candidates` list instead of an error when
`WOOLIES_MCP_URL` is unset. Unlike the other tools, "can't resolve anything right
now" already has a well-defined, harmless caller-side fallback (Tier 2/3 in the
disambiguation flow), so silently falling through is the correct behavior here,
not a gap to paper over.

## Storage

Flat JSON file (`$DATA_DIR/db.json`) holding `items` and `purchase_events`, written
atomically (write-temp-then-rename) with an in-process write queue serializing
concurrent tool calls. No baked-in state — the volume is the only thing that needs
to move if this migrates off the NAS later. Move to SQLite in the same volume if
reconciliation ever needs real queries (per CLAUDE.md) — not needed yet.

## Replenishment logic

- **`todayIso()` is hardcoded to `Pacific/Auckland`, not the container's own
  clock.** Found live while investigating an unrelated status bug: both
  staples-host and discordbot-host run in UTC on the NAS (no `TZ` set, the
  standard minimal-base-image default), while the household is in NZ
  (UTC+12/+13). `new Date().toISOString()` is always UTC regardless of any
  `TZ` env var, so the old implementation returned *yesterday's* date for
  roughly the first half of every NZ calendar day — confirmed directly:
  real NZ date `2026-09-06` vs. the old code's `2026-09-05`, at the same
  instant. This affected `ingest_receipt`/`ingest_order_text`'s fallback
  date (`date ?? todayIso()`) and every `daysSince()` call underlying
  due/overdue math. Fixed via `Intl.DateTimeFormat` with an explicit
  `timeZone: "Pacific/Auckland"`, confirmed working in the actual
  `node:24-slim` base image (full ICU, no separate tzdata package needed)
  — hardcoded rather than reading `TZ` from the environment so it's correct
  regardless of container/OS config and can't silently regress on a future
  redeploy. Checked the real production data for anything already affected
  by the old fallback: zero purchase events existed at the time this was
  found, so nothing needed correcting — only future ingests were at risk.
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

**`item.status` is a write-time cache, never trusted as authoritative on
read.** It's only ever updated by `recomputeItemSummary()`, called after
`record_purchase`/`ingest_receipt`/`ingest_order_text` — correct for every
organic code path (`purchase_events` is append-only, no delete tool exists,
so it can't drift under normal use). But `list_staples`, `get_item`, and
`push_status_to_craft` all derive status fresh via `computeStatus` at read
time rather than returning the stored field directly, so a caller is never
exposed to a stale value regardless of how one might arise — a manual
`db.json` edit, a future migration, a bug in some future write path. Found
live: this project's own test-data cleanup (editing `db.json` directly to
remove synthetic purchase events, forgetting to also reset `status`) left
an item with `status: "overdue"` and `replenishment_interval_days: null` —
a direct violation of "items with no interval never surface as due" above.
The core due/overdue math was never wrong (`computeStatusFromAnchor` checks
`intervalDays == null` first, unconditionally), but nothing re-verified the
stored field against it on read, so the stale value passed straight
through. Re-deriving on every read closes that whole class of risk instead
of just the one instance.

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
Each recorded event's `product_name` is the extracted line text itself (e.g.
"Mainland Cheese Edam 500g"); `sku` stays null, since a receipt photo never
reliably shows a real Woolworths product SKU.

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
caller's `raw_ref`, or the line text itself) becomes each event's `raw_ref`;
separately, the raw line text itself (e.g. "Mainland Cheese Edam 500g")
always becomes that event's `product_name`, regardless of what `raw_ref`
ended up being — this is what lets `get_item` surface which *specific*
product was bought on a given purchase, not just which generic staple.
`sku` stays null for this source; a receipt/pasted order never reliably
states a real Woolworths product SKU.

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

## Extraction failure modes

Both `ingest_receipt` and `ingest_order_text` used to silently degrade into
an empty result (`items: []`, no error) whenever their one-shot extraction
call's response was truncated or didn't contain parseable JSON — the code
had no way to tell that apart from "this document genuinely has no items,"
a real, legitimate result the extraction prompts explicitly allow.

**Confirmed live against a real 3-page, ~29-item Woolworths order
confirmation (`CD43796389`)**: `ingest_order_text` reported "No item lines
were extracted from the text" even though the document was full of real
items. The actual failure: the model's response hit
`stop_reason: "max_tokens"` mid-array with the old `max_tokens: 1024` —
critically, with no `thinking` param set, this model defaults to *adaptive*
thinking, which alone consumed 749 of those 1024 tokens on internal
reasoning before writing any visible output, leaving no room to finish the
JSON. `parseExtraction()`'s regex-based JSON search (`/\{[\s\S]*\}/`) found
no closing brace in the truncated text and silently returned `{ items: [] }`
— no exception, no error, nothing distinguishing it from a genuinely
item-less message.

Two independent fixes, both needed:

1. **`thinking: { type: "disabled" }`** on both extraction calls — a
   mechanical extract-into-JSON task gets no quality benefit from reasoning,
   and disabling it frees the entire `EXTRACTION_MAX_TOKENS` budget for
   actual output. Confirmed this alone recovers nearly all of the previously
   lost headroom (the same real document extracted completely with the
   budget raised only slightly above the old 1024, once thinking was off).
2. **`EXTRACTION_MAX_TOKENS` raised to 4096** anyway, for real margin beyond
   this one document rather than a value that just barely clears it —
   re-verified against the same real order afterward: all 29 items extracted
   correctly, including every multi-line-wrapped item name, both `(Sub)`
   substitution lines (each correctly recording only the actually-supplied
   product, not the originally-ordered-but-unsupplied one), and correctly
   ignoring the repeated per-page header/footer blocks and "Ask Olive"
   support boilerplate.

Neither fix addresses the underlying silent-failure *shape*, since some
future document could still exceed whatever ceiling is set. `src/extractionGuard.ts`'s
`assertCleanCompletion()` now throws if `stop_reason` isn't `end_turn` (the
only value meaning "finished, nothing cut off" — `max_tokens`,
`stop_sequence`, `tool_use`, `pause_turn`, `refusal`, and
`model_context_window_exceeded` are all treated as a real failure), and
`extractJsonObject()` throws instead of returning a default if no JSON
object can be found or parsed once completion is already confirmed clean.
Both tools' existing top-level `try/catch` already turns a thrown error into
a proper `isError` tool result — verified this fires correctly (deliberately
forcing truncation with a tiny `EXTRACTION_MAX_TOKENS` produced a clear
thrown error, not an empty result), and verified a genuinely item-less
message ("hey, are we out of milk?") still returns cleanly with no error, so
the two cases stay distinguishable.

## suggest_alternatives

The ranking engine behind `#woolworths-ordering`'s disambiguation flow (Tier 1
of the three-tier fallback documented in that channel's workspace CLAUDE.md).
`suggest_alternatives(item_name)` fuzzy-matches `item_name`, takes up to the
10 most recent `purchase_events` that have a `product_name`, and re-resolves
each to a live Woolworths product via `wooliesClient.ts`'s `searchTopProduct`
— a fresh MCP client connection to woolies-mcp per call (`src/wooliesClient.ts`),
not a held-open one, mirroring this server's own stateless-per-request design
for its `/mcp` route. This is staples-host's one narrow, read-only exception
to the Ownership boundaries in CLAUDE.md: search only, no cart access, no
auth token of its own — configured via `WOOLIES_MCP_URL`.

Resolution happens sequentially (`src/alternatives.ts`), not in parallel —
this is a single low-traffic household service, no reason to open up to 10
concurrent connections to a shared external dependency for one request. The
resolved results are deduped by `sku`/`variantKey`, not by the raw
`product_name` text: the same real product can come back worded slightly
differently across receipts/orders (OCR and text extraction aren't
consistent), and deduping on raw text first would fragment one frequently-
bought product's count. Ranked by frequency within that 10-event window,
recency as the tiebreaker only. Returns `top_pick` plus up to 5
`other_candidates` as `{name, sku, price}`, fully resolved and ready to
present — or an empty list (never a guess) if `item_name` isn't a tracked
staple, has no purchase history with a `product_name`, or nothing
historical resolves to a live product anymore (discontinued/delisted
products are dropped individually, not treated as a failure of the whole
call).

**When history alone doesn't fill all 5 `other_candidates`, the rest are
backfilled from a live same-variety search** (`backfillFromLiveSearch` in
`alternatives.ts`). A real household can easily have only ever bought one
distinct product for a given staple — confirmed live, a real "milk" lookup
(2 purchase events, both the same Otis oat milk) had 0 historical
`other_candidates`. Uses the exact same `deriveVarietyQuery` derivation
`get_best_value` uses (see below) via the shared `searchVariety()`, so the
backfilled options genuinely relate to `top_pick` rather than being an
arbitrary search. Excludes anything already *shown* (`top_pick` itself,
plus whichever historical others made the display cap) by `variantKey`,
takes results in the live search's own relevance order with no new
ranking — same "just truncate" rule as Tier 2/3's numbered lists — and
stops once the slots are filled. Verified against the real Otis case: the 5
backfilled candidates were all genuine cross-brand oat milk (So Good,
Boring, Vitasoy, plus Otis's own other variant), and a dedup regression
(synthetic history with one real historical "other" alongside the top pick)
confirmed that product isn't duplicated by the backfill.

**Resolving a historical `product_name` retries with the query trimmed from
the end if the full phrase comes back empty** (`searchTopProductFull` in
`wooliesClient.ts`). Found live: `product_name` is receipt/order-derived
text, which can carry packaging words the real catalogue name never had —
the stored `"Otis oat milk the everyday one 1l carton"` returned nothing
(`search_products` ANDs every query word, and the real catalogue name has no
"carton" in it at all), while the same phrase minus "carton" resolved
immediately. Deliberately not a curated list of packaging words to strip —
unlike `fuzzy.ts`'s `COMPOUND_MODIFIER_WORDS` (a genuine semantic ambiguity
with no ground truth to check a guess against), whether a word belongs here
is a factual question the real catalogue answers directly, one call away, so
retrying against it is more general and self-correcting than guessing which
words are "noise" in advance. Trims one word at a time from the end (the
part of a receipt-derived name most likely to diverge from the catalogue's
own wording), stops at the first non-empty result (least trimming that
works, to avoid over-trimming into a wrong, more generic product), never
below 2 words, and capped at 2 trims — bounding worst-case latency, since
`rankAlternatives` already resolves up to 10 events *sequentially* against
this same external dependency, and an uncapped retry on a name that never
resolves at all (the case that costs the most attempts) risked turning one
`suggest_alternatives` call into enough round-trips to blow past the warm
session's 40s per-tool-call timeout. A genuinely discontinued/unmatchable
product still correctly returns null once every attempt is exhausted.
Verified against the real failing case (now resolves), a genuine no-match
(still correctly null), and a clean query needing no retry (unchanged, no
added latency).

**Best-value entry** (`src/bestValue.ts`): once the top-ranked candidate
resolves, one further search compares it against the same *variety* —
any brand, e.g. all Edam cheese, not narrowed to the top pick's own brand.
The variety query is derived deterministically from the top pick's own
`name`/`brand` (strip the brand and a trailing size like `500g`, e.g.
"Mainland Cheese Edam 500g" → "Cheese Edam", via `deriveVarietyQuery` in
`src/varietyQuery.ts` — shared with the live-search backfill above) — no new
tool parameter, no dependence on the agent extracting a good search term.

**The brand/size strip alone isn't always broad enough, and this was a real,
retroactive correctness gap, not just groundwork for the backfill feature.**
A product whose brand has its own sub-line/product name baked into the
residual — e.g. Otis "Oat Milk The Everyday One" — leaves wording no other
brand would use, so the plain query only ever found that one product back.
Confirmed live: `suggest_alternatives("milk")` was reporting Otis's own oat
milk as its own "best value" ($4.69/1L), silently missing a genuinely
cheaper cross-brand option (So Good, at $3.39/1L) that existed the whole
time. Not caught earlier because the original test case ("Mainland Cheese
Edam 500g" → "Cheese Edam") had no brand sub-line wording to strip. **Any
`best_value` result shown before this fix, for a product with this shape of
naming, may have missed a genuinely cheaper cross-brand alternative** — not
specific to Otis/milk, applies to any brand whose names carry their own
sub-line/product naming beyond the plain brand + size.

Fixed by `wooliesClient.ts`'s `searchVariety()`: if the derived query's
first page returns fewer than 5 results, retries with the query trimmed one
word from the end at a time — confirmed live, "Oat Milk The Everyday One"
and each single trim down to "Oat Milk The" all return only Otis's own 1-3
products; "Oat Milk" (trimmed further, to the same word-count floor
`searchTopProductFull` uses) returns 30, with genuine cross-brand
alternatives at the top. No curated word list (same reasoning as
`searchTopProductFull`'s own retry) and no separate attempt cap the way
that function has one — this runs once or twice per `suggest_alternatives`
call, not up to 10 times, so the latency budget is comfortably wider. Once
a broad-enough query is found, re-fetches it with full `searchAllPages`
pagination (capped at 5 pages as a safety net) so the cheapest-across-
everything claim keeps its coverage guarantee — confirmed live this is
typically 1-2 pages for a variety query, not the dozens a bare generic term
would need.

**This is a best-effort suggestion, not an authoritative cheapest-available
claim, and is documented as such rather than presented more confidently.**
Two real, unfixed limitations: (1) re-opening a variety-wide search reopens
the same `coverage`-checking cost the narrower same-`slug` design would have
avoided — accepted deliberately, since a same-brand-only comparison misses
real cross-brand savings (confirmed live: the true cheapest Edam was a
different brand than the resolved top pick). (2) A variety search's results
mix genuinely comparable products with superficially similar ones that
happen to share words — confirmed live, "edam cheese" returned 5 "Cheese
Snack Crackers & Edam" combo products alongside 18 real cheese products, all
sharing the identical `department`, so that field can't filter them. The
only lever is a short, conservative name-based exclusion heuristic
(`SUSPECT_WORDS` in `bestValue.ts` — "cracker", "snack", etc., excluded only
when absent from the top pick's own name) — not exhaustive category
detection, and a mispriced product in some other category could still slip
through uncaught. Parses each surviving candidate's `unitPrice`, groups by
denomination (varies by product), and returns the cheapest within the
largest same-denomination group as `{name, pricePerUnit}` — omitted
entirely (never guessed) if the top pick has no parseable `unitPrice`, the
variety search finds nothing, or nothing survives the exclusion heuristic.

**`get_best_value(sku)`** (`src/tools/getBestValue.ts`) exposes this same
computation standalone, anchored on any product by SKU rather than only
`suggest_alternatives`'s own Tier-1 top pick. Built so the
`#woolworths-ordering` workspace's Tier 2/3 fallback (which never goes
through `suggest_alternatives` at all — no purchase history to rank against)
can still show a best-value line, a deliberate reversal of the original
Tier-1-only scoping (see that workspace's CLAUDE.md). Resolves the given
`sku` to its full catalogue details via a new `getProductFull()` in
`wooliesClient.ts` (wraps woolies-mcp's `get_product`) — needed because a
cart line from `get_cart` carries `unitPrice` but not `brand`, and
`findBestValue` needs both. Found and fixed live while building this: an
unresolvable SKU made `get_product` return `isError: true` with a plain-text
message instead of JSON, which crashed `JSON.parse` instead of degrading to
"nothing found" — `callWooliesTool` (shared by every woolies-mcp call in
this file) now checks `isError` before ever trying to parse a response as
JSON.

## Fuzzy matching

`get_item`, `record_purchase`, `filter_staples`, `ingest_receipt`,
`ingest_order_text`, and `suggest_alternatives` match free-text names
(receipt OCR noise, plurals, chat phrasing) against tracked items via
`findBestItemMatch` (`src/fuzzy.ts`), four passes in order: exact match,
forward whole-word substring match, reverse whole-word substring match, then
Fuse.js fuzzy search as a fallback. `sync_from_craft` deliberately does *not*
use this — see above.

**The forward whole-word substring pass exists because Fuse alone silently
failed on real-world data.** Found while verifying `suggest_alternatives`:
Fuse's length-normalized edit-distance score means a short, generic staple
name (most of the actual synced list — "Bread", "Milk", "Salt", "Pepper",
"Rice") scores as *no match at all* against a long, verbose real product
line (e.g. "Woolworths Bread Wholemeal 700g") — confirmed directly, and not
fixable via `ignoreLocation`/`distance` tuning, since the penalty comes from
the length mismatch itself, not match position. This affected the majority
of the real Craft-synced staples list (10 of 12 tracked items at the time
this was found), meaning most real receipt/order imports would have
silently landed as `unmatched` — this was caught before any real purchase
history existed to be lost, not after.

The fix checks whether the item's name appears as a `\b`-anchored whole word
(or word sequence) inside the query. Word-boundary anchoring specifically
avoids matching inside partial words or compounds ("Rice" must not match
inside "apprice" or "Gingerbread"). When more than one staple's name appears
in the query (e.g. both "Milk" and "Oat Milk" are tracked and the line says
"Oat Milk"), the longest — most specific — match wins.

**That pass was, in turn, too permissive: a parallel investigation found it
was actively corrupting real purchase history.** "Harvest snaps pea crisps
salt & vinegar 120g" and "Pico organic chocolate bar sea salt 80g" both
matched "Salt", and "Pics peanut butter crunchy 380g" matched "Butter" — a
short generic staple name appearing as an incidental flavor/ingredient
word, not the actual product, in all three. A first attempt at a general
fix (reject a match when the staple name is too small a proportion of the
query's words) failed against real data: "Ploughmans bakery toast bread
country grains 750g" is a genuine "Bread" match with the *identical*
word-count shape (1 of 6 real words) as the bad "Salt" matches — no
positional/proportional signal separates a verbose-but-genuine match from a
verbose-but-wrong one, since both dilute the ratio the same way. The actual
fix rejects a match based on what's *immediately adjacent* to it: flanked by
`&`/`and` (catches "X & Y" flavor-pairing generally, e.g. "salt & vinegar"),
or immediately preceded by a word from `COMPOUND_MODIFIER_WORDS` — a small,
deliberately open-ended list (`peanut`, `sea`, `garlic`, `brown`, `bell`,
...) of words that turn a generic staple into a different product/flavor
when placed right before it. Documented and maintained the same way as
`bestValue.ts`'s `SUSPECT_WORDS`: a best-effort heuristic verified against
real cases, not a semantic guarantee — extend it when a new false-positive
pattern turns up, don't try to derive a universal rule.

**The reverse pass is a separate, symmetric gap in the other direction:** a
tracked staple isn't always named with a short generic category — a real
staple named "Otis oat milk the everyday one" was invisible to a plain
"milk" lookup (`suggest_alternatives`, `get_item`, and `record_purchase` all
take a short name and need to find whichever staple it refers to), since the
forward pass only handles a short *item* name inside a long query, never a
short *query* inside a long item name. The reverse pass checks the other
direction — does the query appear as a whole word/phrase inside a longer
item name — guarded by a small stopword list (`the`, `and`, `one`, ...) so a
short query can't accidentally match a stray filler word buried inside a
long item name. No `COMPOUND_MODIFIER_WORDS`-style gate here: this is the
read/lookup direction, not blind text-mining of a noisy receipt line, so the
corruption risk above doesn't apply the same way.

Four real purchase events on real production data were misattributed by the
over-permissive forward pass before this fix (three against "Salt", one
against "Butter"). Cleanup (removing those events and running
`recomputeItemSummary()` against both items) is deliberately sequenced
*after* this fixed matcher is deployed and live, not before — so nothing can
re-corrupt Salt/Butter in the gap between cleanup and deployment.

## Known open items (not yet resolved — see CLAUDE.md)

- Order-history API sync (`woolies-mcp` → `staples-host`) isn't implemented —
  blocked on the API fix landing.
- Reconciliation between `receipt_scan` and `order_history_api` events isn't
  implemented — the exact matching window (~±2 days per CLAUDE.md) needs
  confirming once both sources exist for real.
