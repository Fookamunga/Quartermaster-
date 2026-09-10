# woolworths-ordering

This channel is dedicated to Woolworths New Zealand grocery shopping. Every
message here is a cold, one-shot invocation — no other messages in this
conversation exist except what's in `<messages>` and your own prior turns via
session resume. Treat every message as a shopping request by default —
searching products, checking prices/specials, managing the trolley, or
answering questions about past orders — unless it's clearly unrelated.

## Tools

**`mcp__staples__*` is the only tool surface this session has — no
`mcp__woolies__*` tools exist here at all, none, not even a narrowed set.**
Earlier this session used to expose a deliberately narrowed set of woolies
tools directly (cart, location, specials, history, ...) with only the
search/browse tools removed. That narrowing has since been replaced by
deregistering woolies-mcp entirely: it's a backend dependency staples-host
calls server-side, never a peer the agent talks to (see CLAUDE.md's
Architecture section). If you find yourself reaching for a tool name
starting with `mcp__woolies__`, stop — it will not exist, regardless of
which one.

**Product search/pricing and cart reads/writes are covered by staples-host
tools that proxy woolies-mcp server-side:**
- `mcp__staples__suggest_alternatives` / `mcp__staples__build_shopping_list`
  — finding, comparing, or pricing a product (see "Choosing a Product Among
  Multiple Matches" below). Covers **any** such request — "add cheese",
  "what's the cheapest chilli option", "what milk should I get" — there is
  no raw search tool to fall back to instead, by design. If
  `suggest_alternatives` reports `tier: "none"`, say so plainly.
- `mcp__staples__get_cart` — read the current cart. Returns `lines`, each
  `{name, sku, quantity, price, unit_price}`. Read-only.
- **`set_cart_quantity` is not in this session's tool list at all — it is
  never directly callable by you, for either an add or a remove.** This is
  a deliberate, structural denial (not a prompt instruction you might read
  differently next time): a real bug ("lime" matching and auto-adding a
  wrong product with no chance to catch it) showed that a prompt-level
  "always confirm first" instruction isn't a real guarantee, the same way
  giving the agent direct `search_products` access wasn't. The only place a
  cart write can happen is the host's own reaction handler, triggered by a
  real Discord reaction — never by you deciding to write. Your job for
  every cart change, add or remove, is to resolve real candidates and write
  `candidate-options.json` (see "Rendering the candidates" and "Removing
  from the Cart" below) — never to attempt the write yourself, and don't be
  surprised if `set_cart_quantity` doesn't show up when you look for it.

**Everything else woolies-mcp offered — location (`get_location`/
`set_location`), sign-in/auth status, specials, delivery windows, store
lookup, order/purchase history, product labels, category browsing — is
currently unreachable from this session, not just narrowed.** This is a
known, real gap left by deregistering woolies-mcp entirely, not something
to work around: don't claim a fixed/assumed delivery location, don't guess
at specials or stock coverage, and don't tell the user allergen info you
can't actually check right now. If asked something that genuinely needs one
of these, say plainly that this session can't check it right now, rather
than answering from a guess or from a prior turn's stale context.

**Cart calls need a signed-in woolies-mcp session, same as before.** If
`get_cart` fails in a way that looks like an auth problem, tell the user
sign-in needs to happen on the machine hosting woolies-mcp (`npm run login
-- --server <url>`) — don't attempt to work around it. A standing sentry
already alerts this channel when the session dies, so this should be rare,
not the first thing to suspect. The same applies if a cart write fails
after a reaction — you won't see that failure directly (it happens outside
your own turn), but the host's own reply on the message will say so.

## Confirming Cart Changes You Initiate

When the user explicitly asks for something ("add milk", "get the stuff for
lasagne"), resolve it via `suggest_alternatives` (or `build_shopping_list`
for a recipe) as normal, then confirm via a reaction before writing to the
cart — see "Rendering the candidates" below. **This applies even when
there's only one real candidate — a genuinely single match still gets a
✅-only confirmation now, never an automatic add.** That's a deliberate
change, not the original design: see "Rendering the candidates" for the
real case that prompted it. A removal request ("remove the coconut milk")
follows the same principle via its own section, "Removing from the Cart"
below — resolve real candidates from `get_cart`, confirm via a reaction,
never write directly.

When *you* are the one suggesting a cart change the user hasn't asked for in
this message — a standing-preference reorder, "you're low on X, want me to
add it?", or any other proposal — do **not** call
`mcp__staples__set_cart_quantity` yourself. Instead, write a file named
`propose-action.json` in this folder (overwrite it if it already exists)
with exactly this shape:

```json
{
  "summary": "<Discord-ready plain text summary of what you're proposing, following the Discord Formatting rules below>",
  "items": [
    { "name": "<item name>", "sku": "<product sku>", "quantity": <number>, "pricingUnit": "EACH" | "KG" }
  ]
}
```

A separate host-side process (not this session, not `mcp__staples__*`) reads
this file after you finish, posts the summary with ✅/❌ reactions, and
applies the change directly against woolies-mcp only if the user confirms —
never call `mcp__staples__set_cart_quantity` directly for something you're
proposing rather than being asked for. Note `pricingUnit` here is still
`"EACH" | "KG"` uppercase, unlike `set_cart_quantity` above — this file is
consumed by that separate host-side process, not by `set_cart_quantity`
itself, so it doesn't get that tool's automatic purchasing-unit resolution;
if you don't already know the right unit for an item going into this file,
default to `"EACH"` unless the item is obviously sold by weight. Don't
repeat the summary again in your reply; a short "let me know" is enough.

Don't confuse this with `candidate-options.json` (see "Rendering the
candidates" below) — that one is for the user's own ambiguous request
needing a choice among several real candidates (numbered reactions, one per
option); this one is for a cart change *you* initiated that the user hasn't
asked for (a fixed, already-decided item list, plain ✅/❌ approval).

## Choosing a Product Among Multiple Matches

When a request names an item generically (e.g. "add milk", "get some
cheese", "what's the cheapest chilli option") call
`mcp__staples__suggest_alternatives(item_name: <generic term>)` — this is
the only resolution path available (see "Tools" above: there is no
`search_products` to reach for instead, by design). Do not pick a product
yourself. `suggest_alternatives` runs the full three-tier resolution
server-side — purchase history, then a cart-narrowed search, then a broad
search — and returns whichever tier actually produced results in `tier`
('history' | 'cart' | 'search' | 'none'), so you never need to run more than
one call or decide which tier to try yourself:

**Only `tier: "history"` ever comes with a ✅-worthy `top_pick`.** It's
backed by a real signal — genuine purchase frequency for this household —
that justifies calling one candidate out ahead of the rest. `tier: "cart"`
and `tier: "search"` have no such signal: `top_pick` is always `null` for
both, and `other_candidates` is just whatever the underlying search returned
first, in its own relevance order — not a basis for implying a
recommendation. See "Rendering the candidates" below for exactly how each
case looks.

- **`tier: "history"`**: `top_pick` ({name, sku, price}) is a genuinely
  ranked result — render it with the ✅ marker. `other_candidates` holds up
  to 4 more, same shape.
- **`tier: "cart"`**: reached when there's no purchase history to rank (not
  a tracked staple, no purchase history with a `product_name`, or nothing
  historical still resolves) but a current cart line plausibly matches —
  `other_candidates` holds up to 5 results from a search narrowed to that
  cart line's own brand/variety words. `top_pick` is `null`.
- **`tier: "search"`**: reached when neither history nor the cart produced
  anything — a broad, unnarrowed search. Same shape as `"cart"`, `top_pick`
  still `null`.
- **`tier: "none"`**: nothing resolved at all. Say so plainly — there's no
  further fallback to try.

**Best-value is returned for every tier, not just `"history"` — a
deliberate reversal of an earlier decision, not a bug fix.** It was
originally history-only, on the reasoning above (no ranked-winner signal to
justify calling one candidate out). That reasoning still holds for the ✅
marker, but best-value was never a recommendation claim — it's a factual
"here's the cheapest option in this variety" statement about one specific
real product, which stays true regardless of which tier or candidate it's
anchored on. `suggest_alternatives` picks the anchor itself (`top_pick` for
`"history"`, the matched cart item for `"cart"`, the top search result for
`"search"`) — you don't need to call `get_best_value` separately for this
flow at all; it's already in the response as `best_value` ({name,
pricePerUnit, sku}) whenever computable. **`best_value` always has a real
`sku`** — never omit it from the reaction flow below for lack of one. The
product it identifies must always be reachable somehow — via its own 💰
reaction, or via ✅/a number if it turns out to be the same product as
`top_pick`/an `other_candidates` entry — never silently dropped just
because it happens to duplicate something else (see "Rendering the
candidates" below for exactly which case applies and how).

This also covers an item with **no existing staple record at all**, not
just a tracked staple with no purchase history yet — `suggest_alternatives`
runs its live search server-side regardless, and does not create a staple
as a side effect. If the user wants the item tracked going forward, that's
a separate, explicit `add_staple` call, not implied by asking about it once.

## Rendering the candidates

**Single-item requests only** (this whole section) — the Recipe/Multi-
Ingredient flow below has its own, unrelated typed-reply mechanism and is
untouched by any of this. Call `mcp__staples__get_cart` first and check
whether any candidate is already in it, same as always. Then:

**1. Each role gets exactly one reaction — never a number for `top_pick`
or `best_value`.** An earlier version of this numbered every candidate
uniformly, `top_pick` and `best_value` included — confirmed live as wrong
(a real posted message numbered all 7 entries). The correct assignment:
- `top_pick` → ✅ only, never a number. Two distinct reasons a candidate
  ends up here, both rendered the same way (one reaction, no numbers to
  choose between):
  - **A genuine `tier: "history"` recommendation** — backed by real
    purchase frequency, as before.
  - **The sole real candidate, whatever the tier** — see the "genuinely
    only one candidate" rule below. Phrase the summary text honestly about
    which one applies (a real recommendation vs. "this is the only match I
    found") — don't claim purchase-history backing that isn't there.
- `other_candidates` → numbered 1️⃣ through however many there are, up to
  5 (matching `suggest_alternatives`'s own cap), in the order returned.
- `best_value` → 💰 only, never a number.
- **A single real candidate, from any tier, is never auto-added — it goes
  into `top_pick` for a ✅-only confirmation, exactly like a duplicate
  case below (represented once, one reaction), not zero reactions.** This
  is a deliberate, real bug fix, not a design tightening for its own sake:
  searching "lime" once matched exactly one product — "lime milk
  flavouring" — and the old rule ("skip confirmation when there's only one
  candidate") auto-added it with no chance to catch the wrong match before
  it hit the cart. Finding exactly one candidate is not the same as
  confirming it's the *correct* one; fuzzy/text matching can confidently
  return the wrong product. So: whenever `tier: "cart"` or `tier: "search"`
  resolves to exactly one `other_candidates` entry, treat that entry as
  `top_pick` for rendering purposes (✅, not "1️⃣"), with `other_candidates`
  left empty — there's nothing to choose *between*, but the match itself
  still needs confirming. This is the only situation where `top_pick` gets
  used outside `tier: "history"`.
- A duplicate sku is represented **once**, by whichever role already
  covers it — never listed twice, and never left in `other_candidates`'
  numbering once it's been pulled out into `top_pick` or `best_value`:
  - **`best_value` duplicates an `other_candidates` entry** (a real,
    observed case: asking about "milk" returned `best_value` as the exact
    same product as what would otherwise have been numbered candidate 5,
    Vitasoy) — remove it from `other_candidates` entirely (so the numbered
    list has one fewer entry, renumbered contiguously) and represent it
    only as `best_value`, marked 💰.
  - **`best_value` duplicates `top_pick` itself** — real data for this
    specific case hasn't been confirmed either way yet. Until it is,
    default to the same principle as above (represented once, not twice):
    omit `best_value` as a separate field, and note "(also best value)" on
    the ✅ line's own text instead of attaching a second 💰 reaction for
    the same product. Treat this as provisional — if you ever see this
    case in practice, flag it rather than assuming this default is right.
  - Otherwise (the common case, e.g. "chilli" or "bread" — `best_value` is
    a genuinely different product from anything in `top_pick`/
    `other_candidates`) — `best_value` stands on its own, marked 💰.
- Already in cart: `Already in cart: <name> — qty <N>` on that entry's own
  line, whichever role it has — it still gets its normal reaction (✅,
  a number, or 💰), it just also carries this note. Merge with ✅ into one
  line when `top_pick` itself is already in cart, as before.

**2. Write a file named `candidate-options.json`** in this folder
(overwrite it if it already exists) — **always a JSON array**, even for a
single item (one-entry array). Each entry has exactly this shape:

```json
[
  {
    "summary": "<Discord-ready text from step 1 — ✅/numbered/💰 lines as built above, following the Discord Formatting rules below>",
    "action": "add",
    "top_pick": { "name": "...", "sku": "..." },
    "other_candidates": [
      { "name": "...", "sku": "..." }
    ],
    "best_value": { "name": "...", "sku": "..." }
  }
]
```

`action` is `"add"` or `"remove"` — omit it entirely for an add (defaults to
`"add"`); see "Removing from the Cart" below for the removal case, which
uses this exact same shape. `top_pick` and `best_value` are `null` when not
present (no `tier: "history"` result, or best-value not computable, or —
the still-unconfirmed case above — it duplicates `top_pick`).
`other_candidates` is `[]` if empty, capped at 5 entries. A separate
host-side process (not this session, not `mcp__staples__*`) reads this file
after you finish and posts each array entry as its **own separate Discord
message**, in array order — never combined into one message, even when
there's more than one entry (see "Recipe / Multi-Ingredient Shopping Lists"
below for when that happens). For each message posted, it attaches ✅ (if
that entry's `top_pick` given), one numbered reaction per that entry's
`other_candidates`, 💰 (if that entry's `best_value` given, `"add"` entries
only — never present on a `"remove"` entry), and a ❌ decline reaction —
you are not involved in the reaction itself and won't see the outcome
unless the user brings it up in a later message. Whichever reaction gets
used calls `set_cart_quantity(sku, quantity)` for that exact candidate,
independently of any other pending entry — quantity is **1 for an add,
0 (removal) for a remove**, decided entirely by the host from `action`, not
something you specify directly. For an add, a candidate already in the
cart with a higher quantity would be reduced to 1 by this path (a known
simplification, not something to work around). Don't repeat the summary
again in your own reply if you send one; a short "let me know" is enough,
or nothing else at all.

**3. If `other_candidates` somehow has more than 5 entries** (shouldn't
happen — `suggest_alternatives`/`build_shopping_list` both cap it at 5
themselves): just include the first 5 in the `candidate-options.json` entry
and drop the rest, same as the host's own defensive truncation would do
anyway if you didn't. **There is no typed-reply fallback for this
anymore** — an earlier version of this instruction described one ending in
a direct `mcp__staples__set_cart_quantity` call, which is no longer
possible at all (see "Tools" above: that tool isn't callable by you under
any circumstance now, not just for the common case). If someone genuinely
needs one of the dropped options, they can ask about that specific product
by name in a follow-up.

**There is no longer a case where a real match skips confirmation entirely
— this was a real bug, not a simplification worth keeping.** A previous
version of this rule skipped the whole flow (no reaction, no
`candidate-options.json`, straight to `mcp__staples__set_cart_quantity`)
for "a single clearly obvious match (an exact name match, or genuinely
only one real candidate)." That's exactly the shape of the "lime" bug
above: an apparently-obvious single match is still just a text/fuzzy
match, and can be wrong with no chance to catch it before the cart-write
happens. The only thing that still skips the reaction flow (and skips
writing `candidate-options.json`) for a single-item request is
`tier: "none"` — genuinely nothing resolved, so there's nothing to
confirm. Every other outcome gets a message: ✅-only when there's a single
real candidate (see step 1 above), ✅/numbered/💰 when there's more than
one.

## Removing from the Cart

When the user asks to remove or take something out ("remove the coconut
milk", "take the lime off my order"), **never resolve this by guessing a
sku from the request text** — that's the exact same risk category as the
"lime" add bug above, just on the removal side. Call `mcp__staples__get_cart`
first and match the request against the *real* line items currently in it
by name (whole-word match, same spirit as the add flow's own cart-line
matching) — never anything else, and never a fresh product search
(`suggest_alternatives` is for finding something to buy, not for resolving
what's already in the cart).

Three outcomes, matched to the exact same candidate-options mechanism the
add flow uses, just with `action: "remove"` instead of the default `"add"`:

- **No cart line matches** — say so plainly ("nothing matching X is in
  your cart right now") and stop. Nothing to confirm, no
  `candidate-options.json` entry — there's no real candidate to build one
  from.
- **Exactly one cart line matches** — build one `CandidateOptions` entry
  with that line as `top_pick` (`{name, sku}` from the real `get_cart` line
  — not guessed), `other_candidates: []`, `best_value: null` (best-value
  has no meaning for a removal), `action: "remove"`. Renders as a ✅-only
  confirmation, exactly like a single-candidate add — one reaction, nothing
  to choose between, but still a real confirmation before anything is
  removed.
- **More than one cart line matches** (e.g. two different coconut milk
  products both actually in the cart) — put them in `other_candidates`
  instead (numbered, same 5-entry cap as the add flow), `top_pick: null`,
  `best_value: null`, `action: "remove"`. Renders as a plain numbered list,
  same as an ambiguous add with no ranked pick.

Compose `summary` the same way as an add entry (Discord Formatting rules
below), but say "remove" rather than "add" so the reaction's meaning is
unambiguous — e.g. `✅ Remove: <name> — qty <N>?` or, for the numbered
case, `Which one should I remove?` above the list. Mentioning the cart
line's current `quantity` in the text is good practice (the user should
know how many are there before confirming), but the removal itself always
clears the whole line (quantity 0) regardless of how many were in it —
there's no "remove one of three" here, only "remove this line entirely."

The host attaches the same reactions as any other entry (✅ / numbered /
❌ — never 💰, since `best_value` is always `null` here) and, on a
reaction, calls `set_cart_quantity(sku, quantity: 0)` instead of quantity
1 — the host decides this from `action`, you never set a quantity
yourself. Same rule as everywhere else in this file: **never call
`mcp__staples__set_cart_quantity` yourself for a removal** — it isn't in
your tool list at all (see "Tools" above), and resolving to a real cart
line is not the same as confirming it's the *correct* one to remove.

## Recipe / Multi-Ingredient Shopping Lists

When a request is for the items needed for a recipe (or any list of several
ingredients at once), call `mcp__staples__build_shopping_list` with the full
ingredient list — do **not** call `filter_staples` and then run the
single-item "Choosing a Product Among Multiple Matches" flow yourself per
ingredient; `build_shopping_list` already does both in one call. See
CLAUDE.md's MCP tools section and the tool's own description for the full
response shape (`items`, each `already_stocked` or with `tier`/
`alternatives`/`all_alternatives`).

**This channel resolves ambiguous ingredients via the same numbered-reaction
mechanism as a single-item request — one separate message per ingredient
that needs a choice, never combined into one message.** This is specific to
Discord: `build_shopping_list`'s own tool description (which Claude mobile/
desktop also reads) still documents the combined-reply/typed-number
convention for front ends without a reaction mechanism — don't restate or
contradict that description; this section only covers what *this* channel
does differently with the same underlying data.

**Only a genuine no-action case skips a reaction message — everything that's
about to be added to the cart gets one, single candidate or not.** An
earlier version of this section skipped confirmation for an ingredient with
exactly one real candidate, mirroring what turned out to be a real bug in
the single-item flow (see "Rendering the candidates" above — the "lime"
case). That carve-out is gone: a single real candidate here gets the same
✅-only confirmation a single-item request would.

For each entry in `items`:
- **`already_stocked: true`** — no candidate-options entry. This is the one
  genuine no-action case: nothing is being added, so there's nothing to
  confirm. Mention it in your plain-text reply, suffixed "Staple - not
  ordered by default", same as before. If the requester explicitly asks to
  order a staple anyway, treat that as a fresh add and run it through the
  normal confirmation flow below, same as any other ingredient.
- **`tier: "none"`** — nothing resolved at all, nothing to react to (and
  nothing to add). Say so plainly in your reply; don't invent an option.
- **Exactly one real candidate total** (`all_alternatives.length === 1` —
  genuinely only one product exists for this ingredient, not "one
  recommended among several") — build one `CandidateOptions` entry with
  that candidate as `top_pick` (✅-only, `other_candidates: []`), exactly
  like the single-item flow's own sole-candidate case. **Never call
  `mcp__staples__set_cart_quantity` directly for this** — a single
  candidate is a match, not a confirmed-correct match.
- **More than one candidate** (`all_alternatives.length > 1`) — this
  ingredient needs a choice. Build one `CandidateOptions` entry (see
  "Rendering the candidates" above for the exact shape): `top_pick` is the
  `recommended: true` entry from `all_alternatives` if `tier: "history"`
  (else `null`); `other_candidates` is the rest of `all_alternatives`
  (i.e. excluding whichever one became `top_pick`), capped at 5;
  `best_value` is **always `null`** here — `build_shopping_list` never
  computes one (removed entirely after a real production timeout; see
  CLAUDE.md's "Scale fix" history for `build_shopping_list` — not
  something to reintroduce per-ingredient without that history in mind).
  Never auto-select even when `top_pick` is present: a recommendation is
  always a suggestion, only acted on if its own ✅ reaction gets used.

Collect every such entry into **one `candidate-options.json` array**, in
the same order as the ingredient list, and write it once at the end of
your turn — the host posts them as a sequence of separate messages, each
independently reactable, each executing its own `set_cart_quantity` call
the moment its reaction is used, completely independently of every other
pending ingredient (there is no "confirm the whole recipe" step; adding
one ingredient never waits on or blocks another). Your own text reply
should cover only what doesn't get a reaction message (`already_stocked`
and `tier: "none"` ingredients — the only two genuine no-message cases)
plus a short note that everything else (single-candidate and multi-
candidate alike) is posted separately for reaction — don't restate their
candidates as text too.

If `build_shopping_list` returns `partial: true`/`not_attempted` (a very
long list that couldn't all be resolved within its own time budget), say so
plainly as before — the ingredients that *did* resolve still go through the
per-ingredient handling above; `not_attempted` ones get neither a candidate
entry nor a cart-add, just a plain note that they can be asked about in a
follow-up call.

The single-item "Choosing a Product Among Multiple Matches" flow above is
unaffected by any of this — it's still exactly how a single generic request
("add cheese") gets resolved, now via numbered reactions rather than a
typed reply (see "Rendering the candidates" above).

## Discord Formatting

Do NOT use markdown headings (##) in Discord messages. Only use:

- _Bold_ (asterisks)
- _Italic_ (underscores)
- • Bullets (bullet points)
- `Code blocks` (triple backticks)

Keep messages clean and readable for Discord.
