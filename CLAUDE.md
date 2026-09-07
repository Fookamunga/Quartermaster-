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
- staples-host owns its item list and purchase history directly — no
  external sync, no Craft dependency. Craft integration (`sync_from_craft`,
  `push_status_to_craft`) has been removed entirely: item management is
  conversational now, via `add_staple`/`remove_staple`/`update_staple` (see
  MCP tools below), from Discord or Claude mobile/desktop, not a synced
  external document.
- staples-host calls woolies-mcp directly for narrow, read-only reasons —
  order-history sync (once Adrian's API fix lands), `suggest_alternatives`'
  product-name resolution, and `build_shopping_list`'s Tier 2/3 fallback
  (`get_cart`, `search_products`) when an ingredient has no purchase-history
  top pick (see MCP tools below) — never for anything that writes to the cart
  or places an order. Confirmed by diagram: discordbot-host and Claude mobile
  both talk to staples-host only for the disambiguation flow, never to
  woolies-mcp directly — staples-host is the sole caller of `search_products`
  (and, as of `build_shopping_list`, `get_cart`) here, returning
  fully-resolved results (name, sku, price) back to whichever front end
  asked. All cart/order-writing actions remain woolies-mcp's job alone.
- The Woolworths auth token never leaves woolies-mcp — staples-host's calls
  into it are plain MCP tool calls like any other caller's, no separate
  credential of its own.

**Data model:**
- `items`: item_id, name, sku (cached, self-heals via woolies-mcp `search_products`
  if stale), replenishment_interval_days (null until set or learned), interval_confidence
  (`seeded` | `learned` | `manual` — `seeded` now means only "no restock rate
  at all yet"; `manual` is a human-set restock rate via `add_staple`/`update_staple`,
  never silently overwritten by a learned value — see Replenishment logic),
  status (`not_due` | `due` | `overdue`, default `not_due`)
- `purchase_events` (append-only): event_id, item_id, date, source (`receipt_scan` |
  `order_history_api`), raw_ref, order_reference (order/invoice number, e.g.
  Woolworths NZ's "Order Confirmation/Invoice Number CD47859895"; null for
  sources with no invoice number — in-store receipts, handwritten notes),
  product_name (the specific product text as extracted from the source, e.g.
  "Mainland Cheese Edam 500g" — distinct from `item_id`, which points at the
  generic staple, e.g. "Cheese"; null for events recorded before this field
  existed, and for any future manual `record_purchase` call that doesn't
  supply one), sku (a real Woolworths product SKU, when the source structurally
  provides one — expected only from the future `order_history_api` source,
  never reliably present on a scanned receipt or pasted order text, so
  `receipt_scan` events always leave this null rather than guessing),
  quantity (units purchased; every write path sets a concrete number,
  defaulting to 1 when the source doesn't determine one — null only appears
  on events recorded before this field existed. Feeds the learned restock
  rate — see Replenishment logic)
- A historical `product_name` is re-resolved to a live product by
  staples-host's own `suggest_alternatives` tool (see MCP tools below), never
  baked into a stored `sku` that could go stale as products get discontinued
  or renamed.
- `items.last_purchased` / `last_purchased_source`: denormalized, derived from
  `purchase_events`

**MCP tools:**
- `list_staples()` — every staple's name, status, last purchase date, and
  restock rate. Covers both "show me my staples" and "show my restock
  rate"/"show my staples update status" — same data, rendered differently by
  whichever front end asked, no separate status-query tool needed. Restock
  rate phrasing depends on `interval_confidence`: `manual` → "restock rate:
  every N days"; `learned` → "restock rate: ~N days per unit" (a per-unit
  rate now, not a flat gap — see Replenishment logic); `seeded` → "no
  restock rate set yet".
  - "show me my staples" (the default, full-detail view) — one combined
    line per item: `<name> — <last bought <date> or no purchase on record>
    — <restock rate phrase>`, e.g.
    `Bread — last bought 2025-08-18 — restock rate: every 5 days` /
    `Oat milk — last bought 2025-09-01 — restock rate: ~7 days per unit` /
    `Fish sauce — no purchase on record — no restock rate set yet`.
  - "show my restock rate"/"show my staples update status" — simpler:
    just `<name> — <restock rate phrase>`, no last-bought part.
- `get_item(name)`
- `record_purchase(item_name, date, source, quantity?, raw_ref?)` — fuzzy-match,
  append event, update summary. `quantity` optional, defaults to 1.
- `add_staple(name, interval_days?)` — add a new staple to track.
  `interval_days` optional; if omitted, the item starts with no restock rate
  at all (`seeded`, the same "not enough data yet" state a fresh item always
  started in), eligible to learn one automatically once enough purchase
  history exists. If given, the restock rate is marked `manual` and is
  never silently overwritten by a learned value even once enough history
  exists to compute one (see Replenishment logic) — change it later via
  `update_staple`. Fails if a staple with this exact name (case-insensitive)
  already exists.
- `remove_staple(name)` — delete a staple entirely. Its `purchase_events` are
  retained, not deleted — orphaned (no longer attached to any tracked item),
  in case the staple is re-added later. Needs no special handling elsewhere:
  every reader (`list_staples`, `get_item`, `suggest_alternatives`,
  `record_purchase`, ingest tools, ...) looks up the item first and only
  then filters `purchase_events` by its `item_id`, so an orphaned event for
  a deleted item is simply never reached by any of them. Re-adding a staple
  with the same name gets a new `item_id` (via `add_staple`), so it does not
  recover the old history automatically.
- `update_staple(name, new_name?, interval_days?)` — rename a staple and/or
  change its restock rate. Setting `interval_days` marks it `manual`, same
  never-silently-overwritten guarantee as `add_staple`'s. Replaces the
  former `set_interval` tool — same underlying mechanism
  (`computeStatusFromAnchor`), minus its optional `last_purchased` anchor
  param, dropped rather than carried forward (`record_purchase` already
  covers anchoring a fresh item via a real purchase; can be added back if a
  real need for it shows up).
- `suggest_alternatives(item_name)` — the single tool behind
  `#woolworths-ordering`'s disambiguation flow (see that channel's workspace
  CLAUDE.md's "Choosing a Product Among Multiple Matches" for the full
  picture). Runs a full three-tier resolution server-side and returns
  whichever tier actually produced results as an explicit `tier` field
  (`"history" | "cart" | "search" | "none"`), so the caller — Claude mobile/
  desktop or discordbot-host's agent — never needs to try more than one tier
  itself or hold a search tool of its own to do so (see "Tool-routing fix:
  search tools removed from the agent" below for why this matters):
  - **`"history"`** (originally the tool's only tier): fuzzy-matches
    `item_name` against the staples list, reads that item's
    `purchase_events`, and for up to the 10 most recent events with a
    `product_name`, re-resolves each to a live product via woolies-mcp's own
    `search_products` — staples-host's own narrow exception to the Ownership
    boundaries above: read-only, search only, no cart access, no auth token
    of its own. Dedupes the resolved results by `sku`/`variantKey` (not by
    the raw extracted text, which varies across receipts/orders for the same
    real product), ranks by frequency within that window with recency as the
    tiebreaker, and returns the #1 result as `top_pick` (`{name, sku,
    price}`) plus up to 5 more as `other_candidates` — `top_pick` is its own
    explicit field, not array position 0, specifically so a caller can't
    lose track of which result is the ranked winner (see the workspace
    CLAUDE.md's ✅-marking convention, which depends on this being
    unambiguous).
  - **`"cart"` / `"search"`** (`tieredSearch.ts`, new): reached when
    `"history"` finds nothing — not a tracked staple, no purchase history
    with a `product_name`, or none of the historical names resolve to a live
    product anymore. `"cart"` looks for a current cart line plausibly
    matching `item_name` and narrows a live search using that line's own
    brand/variety words; `"search"` (reached only if `"cart"` also finds
    nothing) runs a broad, unnarrowed search. Both return up to 5 results as
    `other_candidates` with `top_pick: null` — no ranking signal exists at
    either tier, so nothing is singled out. **Neither requires `item_name`
    to match an existing tracked staple at all** — this is what makes a
    one-off item with no staple record (not just "tracked staple, no
    purchase history yet") resolvable through this same tool, without ever
    creating a staple as a side effect of answering a search/pricing
    question.
  - **`"none"`**: nothing resolved across all three tiers. Empty/null
    fields, never a guess.
  - Identically callable from Claude mobile/desktop directly, not just
    discordbot-host's cold session — same boundary as every other
    staples-host tool.

  **Live-search backfill when history alone can't fill 5 `other_candidates`**
  (`alternatives.ts`): a real household can easily have bought only *one*
  distinct product for a given staple ever — confirmed live, a real "milk"
  lookup with 2 purchase events (both the same Otis oat milk) had 0
  `other_candidates` from history alone. Rather than showing `top_pick` with
  nothing else, the remaining slots are filled from a live same-variety
  search, using the *same* `deriveVarietyQuery` derivation `get_best_value`
  uses (see below) — so the backfilled options genuinely relate to
  `top_pick`, not an arbitrary search. Excludes anything already *shown*
  (`top_pick` itself, plus whichever historical others made the display
  cap) by `variantKey`, takes results in the live search's own relevance
  order with no new ranking, and stops once the slots are filled — same
  "just truncate, don't re-rank" rule as Tier 2/3's numbered lists. Never
  fabricates: a connection failure or a variety search that finds nothing
  usable just means fewer than 5 `other_candidates`, same as before this
  existed.

  **Best-value entry (additive, never replaces/reorders the ranked
  candidates), computed for every tier, not just `"history"`:** once
  whichever tier fired has a real anchor product (`top_pick` for
  `"history"`; the matched cart item itself, not the narrowed search's own
  top result, for `"cart"`; the top search result for `"search"`), one
  further search compares it against the same *variety*, any brand -- e.g. all Edam cheese
  (Mainland, Woolworths, Dairyworks, Chesdale, Anchor, ...), not narrowed to
  the top pick's own brand. Deliberately broader than a same-`slug` (same
  product line) comparison: confirmed live that the narrower scope misses
  real savings a shopper would actually want to know about (Mainland's own
  cheapest Edam size priced out at $1.41/100g; the real cheapest Edam
  anywhere was a *different brand*, Woolworths Cheese Edam 1kg at
  $1.36/100g -- invisible to a same-brand-only comparison).

  The variety query is derived deterministically from the top pick's own
  `name` and `brand` fields -- strip the brand and a trailing size pattern
  (e.g. `\d+\s*(g|kg|ml|l)`) from the name, e.g. "Mainland Cheese Edam 500g"
  minus brand "Mainland" minus size "500g" leaves "Cheese Edam" as the
  query. This keeps the tool fully self-contained server-side: no new
  parameter, no dependence on the agent extracting a good search term
  itself. Follows `search_products` pagination until `coverage`/`complete`
  says so -- confirmed live this is bounded (a variety-level query like
  "edam cheese" needed 2 pages for 23 results), not the dozens of pages an
  unnarrowed generic term like "cheese" (~475 matches) would need.

  **The brand/size strip alone isn't always broad enough, and this was a
  real, retroactive correctness gap, not just groundwork for the live-search
  backfill above.** A product whose brand has its own sub-line/product name
  baked into the residual -- e.g. Otis "Oat Milk The Everyday One" -- leaves
  wording no other brand would use, so the plain query only ever found that
  one product back. Confirmed live: `suggest_alternatives("milk")` was
  reporting Otis's own oat milk as its own "best value" ($4.69/1L),
  silently missing a genuinely cheaper cross-brand option (So Good, at
  $3.39/1L) that existed the whole time. Not caught earlier because the
  original test case ("Mainland Cheese Edam 500g" -> "Cheese Edam") had no
  brand sub-line wording to strip. **Any `best_value` result shown before
  this fix, for a product with this shape of naming, may have missed a
  genuinely cheaper cross-brand alternative** -- not specific to Otis/milk,
  applies to any brand whose product names carry their own sub-line/product
  naming beyond the plain brand + size.

  Fixed by `wooliesClient.ts`'s `searchVariety()`, shared by this tool and
  the live-search backfill above (both start from the same derived query):
  if the query's first page returns fewer than 5 results, retries with the
  query trimmed one word from the end at a time -- confirmed live, "Oat Milk
  The Everyday One" and each single trim down to "Oat Milk The" all return
  only Otis's own 1-3 products; "Oat Milk" (trimmed further) returns 30,
  with genuine cross-brand alternatives at the top. No curated word list
  (the real catalogue is checked directly, same reasoning as
  `searchTopProductFull`'s own retry in the ingest direction) and no
  separate attempt cap the way that function has one (this runs once or
  twice per `suggest_alternatives` call, not up to 10 times, so the latency
  budget is comfortably wider) -- only the same word-count floor.

  **This reopens exactly the coverage-checking cost the same-line version
  avoided, and accepts it deliberately for a materially better answer.**
  It also inherits a real data-quality risk with no clean fix: a variety
  query's results mix genuine comparable products with superficially
  similar but different items that happen to match the same words --
  confirmed live, "edam cheese" returned 5 "Cheese Snack Crackers & Edam"
  combo products (a completely different product type) alongside 18 actual
  cheese products, all sharing the identical `department` field, so
  department can't filter them out. The only lever is a name-based
  heuristic -- excluding results whose name contains a word (e.g.
  "cracker", "snack") that the top pick's own name doesn't contain -- and
  it is not a guarantee: a combo product happening to price lower per unit
  than genuine alternatives in some other category could still slip
  through uncaught. **`suggest_alternatives`'s best-value entry is
  documented and accepted as a best-effort suggestion, not an authoritative
  cheapest-available claim** -- do not present or treat it as a stronger
  guarantee than that.

  Parses each surviving candidate's `unitPrice` (a formatted string, e.g.
  `"$1.90 / 100G"` -- present on most products but not all, and its
  denomination varies by product), groups by denomination, and returns the
  cheapest within the largest same-denomination group as
  `{name, pricePerUnit}`. Omitted entirely (never guessed) if the top pick
  has no parseable `unitPrice`, the variety search finds nothing usable, or
  nothing survives the exclusion heuristic.
- `get_best_value(sku)` — the same best-value computation above, exposed
  standalone so it can be anchored on any product, not just whichever one
  `suggest_alternatives` itself anchors on internally now (see above --
  `suggest_alternatives` already computes and returns `best_value` for all
  three of its own tiers, so the single-item disambiguation flow no longer
  needs to call this separately; it stays useful for anchoring on a product
  from somewhere else entirely, e.g. a `get_cart` line or an order-history
  reference the agent already has a sku for). **Deliberate reversal of an
  earlier decision, not a bug fix**: best-value was originally scoped to
  Tier 1 only, on the reasoning that Tier 2/3 have no ranked-winner signal to
  anchor it on. That's still true, but best-value was never a claim about
  which candidate the household prefers — it's a factual "here's the
  cheapest option in this variety" statement, which stays valid regardless
  of *which* real product it's anchored on. Resolves the given `sku` to its
  full catalogue details (`brand`, `unitPrice` — the fields a cart line from
  `get_cart` doesn't carry) via woolies-mcp's `get_product`, then runs the
  identical `findBestValue()` logic `suggest_alternatives` already uses
  internally. Returns `{name, pricePerUnit}` or an empty object if nothing
  computable — same semantics, never a guess.
- `filter_staples(ingredients: string[])` — which ingredients aren't already-stocked
- `build_shopping_list(ingredients: string[])` — resolves an entire
  multi-ingredient list (e.g. a recipe) in one call, replacing the pattern of
  calling `filter_staples` then `suggest_alternatives` per item yourself.
  Splits already-stocked vs needed via the same logic `filter_staples` uses
  (shared, so the two can't disagree), then per needed ingredient runs the
  same three-tier fallback as the single-item disambiguation flow — purchase
  history (`rankAlternatives`, unchanged), then a cart-narrowed search (its
  own `get_cart` call, matching a plausible line by whole word, narrowing via
  the same `deriveVarietyQuery` best-value already uses), then a broad
  search — capped at 3 alternatives per ingredient, numbered **sequentially
  across the entire response**, not restarted per ingredient, so a flat reply
  like "1 4 6" unambiguously identifies one specific item regardless of how
  many ingredients are in the list. Also returns each ingredient's untrimmed
  alternative set (up to 5) for re-prompting an ingredient the reply didn't
  address — see the tool's own description for the exact reply-interpretation
  contract (which numbers mean what, and the never-auto-select rule), kept
  there rather than duplicated here since that's what reaches Claude
  mobile/desktop identically to Discord, unlike this file. Read-only, same
  as `suggest_alternatives`. See the `#woolworths-ordering` workspace
  CLAUDE.md for when to call this instead of the single-item flow.

  **Scale fix — two rounds, the first against the wrong ceiling.** A real
  14-ingredient recipe (Chilli and Lime Squid Salad, 10 needed) timed out
  in production with no reply at all. Round one root-caused this to
  `findBestValue`'s variety search + full pagination (confirmed live up to
  ~27s of one ingredient's ~32s, 83%) and fixed it with a cheaper
  `fastMode` variant, cutting the real total from 221s to 96s — a genuine
  improvement, but confirmed insufficient once round two tested the actual
  binding constraint: calling the real, already-"fixed" tool through an
  actual MCP client (not just the internal function, which round one only
  tested) failed at exactly 60005ms with `MCP error -32001: Request timed
  out` — `DEFAULT_REQUEST_TIMEOUT_MSEC = 60000`, confirmed directly in the
  installed SDK. This is a hard, ~60s client-side ceiling entirely separate
  from and far shorter than discordbot-host's 300s container-kill, which
  round one had (wrongly) budgeted against — a call that runs past it gets
  killed with **no response at all**, regardless of how close staples-host
  was to finishing. That's the real mechanism behind "3 attempts, no
  response," confirmed live against production traffic.
  - **`findBestValue` is now removed from `build_shopping_list` entirely**
    (not just made cheaper) — even its fastMode form couldn't reliably clear
    a real 60s ceiling for a realistic ingredient count. Best-value stays
    fully available from the single-item flow
    (`suggest_alternatives`/`get_best_value`), which isn't time-constrained
    the same way — ask about one specific ingredient to get it.
  - **Concurrency was re-evaluated, not just carried over from round one,
    and confirmed still unnecessary** — with best-value gone, the real
    14-ingredient recipe (9 needed) was re-measured at 37-38s **through the
    actual MCP transport**, ~22s of real margin under the 60s ceiling.
    woolies-mcp's own documented "intentional rate-limiting safeguards" for
    single-shopper-scale use remains a real reason to prefer sequential
    calls when performance allows it, and here it does — no need to take on
    that risk.
  - **`TIME_BUDGET_MS` realigned to 45s** (`shoppingList.ts`), down from an
    initial 180s that was itself budgeted against the wrong (300s) ceiling
    and would never have actually engaged before the real 60s timeout fired
    empty-handed. 45s leaves ~15s of margin under the real constraint; if a
    still-larger ingredient list runs past it, the response includes
    `partial: true` and `not_attempted` (remaining ingredient names)
    instead of risking silence again. Checked before starting each
    ingredient, never mid-resolution.
- `check_restock_needed()` — on-demand version of the weekly restock report
  below: which staples are due, overdue, or projected to run out within 7
  days, right now. Calls the exact same `itemsRunningOutSoon()` calculation
  the scheduled Sunday webhook post uses (see below) — not a separate
  approximation, so this always agrees with what that report would say if it
  ran this instant. Returns `items` (sorted most-urgent first, each with
  `days_until_due` and `restock_rate_days`), not pre-formatted text — an
  agent is always in the loop for this tool (unlike the webhook path), so
  phrasing is left to the caller, same as every other staples-host tool. Its
  own description tells the caller to phrase this as a direct answer to a
  direct question, not the weekly report's "📅 Weekly restock check" framing.
- `ingest_receipt(image)` — vision extraction (line items + quantity per line +
  order/invoice reference number, when present) → order_reference dedup check →
  fuzzy-match → record per line, return unmatched lines. See "Order-reference
  dedup" below.
- `ingest_order_text(text, date?, raw_ref?)` — mirrors `ingest_receipt` for pasted
  order-confirmation/order-list text instead of a photo: one-shot text extraction
  (header date + order/invoice reference number, or a stated date, or today +
  quantity per line) → order_reference dedup check → fuzzy-match → record per
  line, return matched/unmatched. Built to close discordbot-host's `#order-import`
  text-parsing gap — see that section for detail.
  Quantity capture (both ingest tools): the extraction prompt captures the
  quantity actually supplied/received per line, not the quantity originally
  ordered when the two differ (e.g. a substitution or partial fulfillment) —
  consistent with how a substitution already resolves to the product actually
  received elsewhere in this flow. Defaults to 1 when no quantity is
  determinable from the source.
**Replenishment logic:** new items start `seeded`, `status = not_due` until ≥2
purchase events exist. What `replenishment_interval_days` actually means, and
how status is computed from it, now depends on `interval_confidence`:

- `manual` (set via `add_staple`/`update_staple`): a flat day-count, exactly as
  before quantity-awareness was added. A human choosing a fixed cadence is
  implicitly choosing one that doesn't vary by how much they buy — this mode
  is entirely quantity-blind by design, and nothing below applies to it.
- `learned` (computed from history, ≥3 events): `replenishment_interval_days`
  is a **days-per-unit rate**, not a flat gap — e.g. 5 units lasting 35 days
  learns a rate of 7 days/unit. Learned as the median, across consecutive
  purchase-event pairs, of `days_between ÷ earlier_event's_quantity`
  (outlier-resistant, same as the old plain-date median). An event with
  `quantity: null` (recorded before quantity was captured) is treated as 1,
  so pre-existing history degrades gracefully to the old flat-interval math
  rather than needing a backfill.
- `seeded`: no rate at all yet, never surfaces as due.

The **effective interval** used for status math (`effectiveIntervalDays()` in
`replenishment.ts`) is the flat value for `manual`, or the learned per-unit
rate × the most recent purchase's quantity for `learned` — e.g. a 7-days/unit
rate with a last purchase of 2 units projects 14 days out; a last purchase of
5 units projects 35 days out. This is why "next due" now reflects what was
actually bought last time rather than a single static number. Status
thresholds apply to that effective interval exactly as before: `not_due`
while `days_since_last_purchased < effective interval`; `due` once
`days_since_last_purchased >= effective interval`; `overdue` once
`days_since_last_purchased >= effective interval * OVERDUE_MULTIPLIER`.
`OVERDUE_MULTIPLIER` was introduced during the build as a tunable constant
(not specified in this brief) — confirm its actual configured value, since it
controls how much slack an item gets before escalating from a soft "due"
nudge to an "overdue" alert.

**Known limitation, not solved:** this model assumes usage scales roughly
linearly with quantity, which holds for non-perishables (e.g. toilet paper,
detergent) but may not for perishables bought in bulk (e.g. 5 bananas may not
last 5x as long as 1, if some spoil before use). No signal exists today to
distinguish the two cases; a per-unit rate is used uniformly, and this is
accepted as a known inaccuracy rather than something worth solving without a
concrete signal to act on.

`suggest_alternatives`'s ranking and `get_best_value`'s computation are
architecturally independent of all of this — neither reads
`replenishment_interval_days`/`interval_confidence`/status anywhere, so this
redesign doesn't touch them.

**Manual restock rates are never silently overwritten.** Once `add_staple`/
`update_staple` sets a restock rate (`interval_confidence: "manual"`),
`recomputeItemSummary()` skips the learned-median computation entirely for
that item, even once ≥3 purchase events exist — the manual value stays in
force until a human explicitly changes it via `update_staple` again. This is
a distinct concept from the organic `seeded` → `learned` path above (which
still applies unchanged to any item that was never manually set) — `seeded`
now means only "no restock rate at all yet," not "possibly manually seeded,"
the two having previously been conflated under one value.

Note for later, out of scope for the Craft-removal/conversational-management
work that introduced this policy: a discrepancy alert — if the learned value
disagrees meaningfully with a manual setting (e.g. real usage suggests
running out earlier than the manual restock rate assumes) — should eventually
surface as a nudge rather than staying silent. Building this would mean
computing the learned rate for manual items too (currently skipped entirely,
not just computed-and-unapplied) and storing it separately for comparison,
without ever overwriting the manual value. Not built now, just flagged here
so it isn't lost. This policy is unaffected by the quantity-aware redesign
above: `manual` stays a flat, quantity-blind day-count either way, so "never
silently overwrite manual" needed no change to accommodate per-unit learning.

**Order-reference dedup (primary, live now):** every purchase event carries an
`order_reference` — the order/invoice number (e.g. Woolworths NZ's "Order
Confirmation/Invoice Number CD47859895"), extracted by `ingest_receipt`'s vision
prompt and `ingest_order_text`'s text-extraction prompt alongside the line items
and date. Dedup is per **line**, not per order — a real gap in the original
order-level design: a genuine multi-page paste of one order (the same
`order_reference` on each page) would have had its second page's line items
skipped entirely along with the first page's, since the check fired on the
reference alone. Before inserting a line, ingestion checks whether that
specific matched item already has a purchase_event under the same
`order_reference`; if so, only that line is skipped (reported as
`already_recorded`, distinct from `matched`), while any other line under the
same reference — new items on a later page, or everything on a genuine
full-duplicate re-paste — is still evaluated and recorded normally. A
full-duplicate re-paste of an already-recorded order still results in zero new
purchase events, just via every line landing in `already_recorded` rather
than one blanket "already imported" skip. Shared by both ingest tools via
`recordOrderLines()` (`staples-host/src/tools/orderLineRecording.ts`) so this
behavior is defined in exactly one place. Still an exact-match check on
`order_reference`, not a fuzzy one, and needs no reconciliation pass to run —
it applies at ingest time, today, for any source that exposes an invoice
number. Once the order-history API sync exists, this is also the primary
mechanism for reconciling `receipt_scan` and `order_history_api` events for
the same order.

**Date-proximity fallback (once order-history API is fixed):** sources with no
invoice number (in-store receipts, handwritten notes) leave `order_reference`
null and fall back to this weaker check instead — match `receipt_scan` and
`order_history_api` events for the same item within ~±2 days, merge, treat API
as authoritative when both exist. Unmatched API events fill gaps, not
duplicates. Only used when an exact `order_reference` match isn't possible —
not an equally-authoritative alternative to it.

**Weekly restock report (direct Discord webhook, no discordbot-host
involvement):** staples-host's own scheduled job — `weeklyReportSentry.ts` —
posts every Sunday 5pm NZ time (`Pacific/Auckland`, hardcoded the same way as
`todayIso()` and `nzTime.ts`, not server-local/UTC) directly to a Discord
webhook, entirely independent of discordbot-host and the Discord bot session.
This is a deliberate architectural departure from the auth-failure/
never-tracked sentries above (both live in discordbot-host and call
staples-host's tools) — this job is staples-host's own, since it needs no
conversational/agent involvement at all, just a scheduled read of its own
data plus one HTTP POST. The `check_restock_needed()` MCP tool (see above)
is the on-demand counterpart — same calculation, called directly instead of
waiting for Sunday.

- **Calculation:** reuses `effectiveIntervalDays`/`computeStatus` exactly as
  `list_staples`/`get_item` do — no new status concept. For each item with a
  restock rate and ≥2 purchase events (same event-count gate `computeStatus`
  already applies — this does mean a freshly-manual item with 0-1 purchases
  won't appear here, inheriting the same discrepancy already documented
  above rather than introducing a new one), `daysUntilDue = effectiveIntervalDays
  − days_since_last_purchased`. Included if `daysUntilDue <= 7` — this single
  rule subsumes "due" and "overdue" (both land at `daysUntilDue <= 0`)
  alongside "not due yet but will be within a week," so no separate
  due/overdue branching is needed. Rendered as two groups, most-urgent-first:
  ⚠️ already due/overdue, and 🔜 running out within 7 days.
- **Always posts**, including a positive "nothing due or running out" message
  when the list is empty — unlike the change-triggered sentries above, a
  fixed-schedule digest going silent for a week is ambiguous between "all
  stocked" and "the job silently broke," so this one confirms every week
  regardless.
- **Scheduling:** a 15-minute `setInterval` (`WEEKLY_REPORT_CHECK_INTERVAL_MS`)
  checks the current NZ weekday/hour (`nzTime.ts`) and fires once the window
  hits Sunday 17:00 — no cron dependency added, matching this codebase's
  existing zero-cron-dependency, `setInterval`-based sentry pattern. A
  `lastWeeklyReportSentAt` field on the `Database` object itself (persisted
  via the existing `withDb`, no new state file) records the NZ-local date
  last sent, preventing a double-post within the same hour or a re-post
  after a restart.
- **Delivery:** a new `DISCORD_WEBHOOK_URL` config value (secret-bearing, no
  default — same "unset degrades gracefully, never a hard failure" pattern
  as `WOOLIES_MCP_URL`/`MCP_AUTH_TOKEN` (the sentry still runs its check and
  logs a warning, just skips the actual POST). Plain `fetch()` to the
  webhook, no new dependency.
- **Claude mobile/desktop delivery — investigated and dropped, not a gap left
  open by omission:** there is no mechanism for an MCP server to push a
  message into an existing Claude mobile/desktop conversation without an
  active session already open — MCP is strictly request/response, scoped to
  a live tool call the client itself initiates, with no server-push
  primitive in the protocol. The Discord webhook is the only delivery path
  for this report; documented here as a known limitation rather than a
  planned follow-up.

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
    agent parsing it first. Also checks for `.txt` file attachments, not
    just `message.content` — Discord auto-converts a paste over ~2000
    characters into a `message.txt` attachment instead of inline content,
    which is the common case for a real order-confirmation paste, not an
    edge case; without this, that content would silently never reach
    `ingest_order_text` at all. Same download pattern already used for
    image attachments (`fetch` + read the body), matched by content-type
    (`text/*`) with a `.txt` filename fallback since Discord doesn't
    always set contentType correctly for plain-text uploads. A message's
    own inline content and any `.txt` attachment(s) are each relayed as
    independent `ingest_order_text` calls, each getting its own reply — so
    a message with both, or multiple attachments, isn't collapsed into one
    call. Replaces an earlier design where the cold
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
  - **`mcp__woolies__*` gets an explicit `disallowedTools` deny list**
    (`WOOLIES_DISALLOWED_TOOLS` in `container/agent-runner/src/index.ts`,
    mirrored by hand in `src/warmSession.ts` since the two are separate
    builds) covering `search_products`, `search_products_batch`,
    `browse_category`, `get_buy_it_again`, and `get_product`. Real, confirmed
    problem this fixes: with both servers connected, the agent would
    sometimes call woolies-mcp's `search_products` directly instead of
    staples-host's `suggest_alternatives`/`build_shopping_list` for
    "find/compare/price a product" requests, bypassing all purchase-history
    ranking, best-value comparison, and cart-awareness those tools exist to
    provide — most reliably reproduced with price-comparison phrasing
    ("what's the cheapest chilli option right now"). **Two rounds of
    strengthening `suggest_alternatives`'s own tool-description wording to
    say "prefer this over search_products" made no measurable difference**
    — confirmed live, re-testing the identical failing prompt against the
    rebuilt description each time — the model was pattern-matching "price
    comparison across a category" to a search task before it ever weighed
    which tool's description fit better.
    - **First structural attempt (an `allowedTools` narrowing instead of a
      deny list) also had zero effect, and this was a second real,
      confirmed-live dead end, not a hypothetical to avoid** — this runner
      sets `permissionMode: "bypassPermissions"` (needed so the cold session
      never blocks on an interactive approval prompt), and the bundled
      Claude Agent SDK explicitly documents that bypass mode auto-approves
      every tool call and *ignores allow rules from `allowedTools`*; only
      deny rules from `disallowedTools` still apply under that mode.
      Confirmed by re-testing the identical failing prompt against the
      rebuilt `allowedTools`-narrowed image: `search_products` was still
      reachable, byte-identical bypass. Switching the same list to
      `disallowedTools` fixed it — confirmed via the session transcript
      (not just the reply text): the agent's first instinct was still to
      call `mcp__woolies__search_products` directly, but it now comes back
      `is_error: true`, `"Error: No such tool available:
      mcp__woolies__search_products"`, and the agent falls back to
      `mcp__staples__suggest_alternatives` correctly.
    - This only works because Tier 2/3 of the single-item disambiguation
      flow (previously the agent's own job — see the workspace CLAUDE.md's
      now-superseded prose) moved server-side into `suggest_alternatives`
      itself at the same time (see that tool's entry above and
      `tieredSearch.ts`) — without that move, the agent would have had no
      way to do Tier 2/3 at all once `search_products` became unreachable.
    - `get_product_label` and `list_categories` stay reachable alongside the
      cart/order/location/auth tools — none of the excluded-vs-kept split is
      about permissions, only about which tools return a product/price
      listing that competes with a staples-host tool for the same phrasing
      (the excluded five do; nothing kept does).
    - staples-host itself is unaffected by any of this — it has always been
      the sole caller of woolies-mcp's `search_products`/`get_cart`/
      `get_product` (see Ownership boundaries above), calling them
      server-side, never through the agent's own tool list.
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
  corrupt the restock-rate data).
- **"Never tracked" item alerting.** Now buildable — staples-host is real.
  Mechanism: a periodic (every 6h) direct host-side call to staples-host's
  `list_staples()`, filtered to items with a restock rate set (`learned` or
  `manual` confidence) **and** no `last_purchased` anchor — the "Never
  tracked" category (formerly a section in the now-removed Craft status
  doc), never "not enough data yet" (no restock rate at all — `seeded`
  confidence, which now means specifically that). The filter checks
  `replenishment_interval_days != null` explicitly rather than trusting
  `status: "due"` alone to imply it — a defensive check against the
  no-restock-rate/no-alert guarantee silently breaking if `status`'s
  derivation ever changes elsewhere. Items with no restock rate must never
  trigger a Discord alert under **any** sentry (this one or a future
  due/overdue one) — the same "stay silent until there's a real basis to
  flag something" goal the replenishment logic itself was built around. No
  agent involved in the poll. Posted as its own distinct message, not folded
  into the auth-failure alert or into cart proposals. Only reposts when the
  filtered item set actually changed since the last post, so it doesn't
  repeat itself every 6 hours for no reason. A test-only bypass (env var or
  manual trigger) lets this be verified on demand instead of waiting up to
  6h for real data — the bypass only shortcuts *when* the check runs, never
  the no-restock-rate exclusion itself.

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
- **Pre-existing status-derivation discrepancy, found while building
  add_staple/update_staple (not introduced by them — confirmed the former
  `set_interval` had the identical behavior already):** a manually-anchored
  item with no real purchase history yet reports `status: "due"` from
  `add_staple`/`update_staple`'s own response (via `computeStatusFromAnchor`,
  which has no purchase-count gate) but `status: "not_due"` from
  `list_staples`/`get_item` immediately after (via `computeStatus`, which
  requires ≥2 purchase events before trusting any anchor). Left as-is,
  per this task's explicit scope boundary against touching the restock-rate/
  status-calculation logic — worth resolving whenever that logic is next
  touched (e.g. the separately-planned replenishment-calculation redesign).
