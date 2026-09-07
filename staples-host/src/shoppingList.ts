import { rankAlternatives, type RankedAlternative } from "./alternatives.js";
import { classifyIngredients } from "./ingredientClassification.js";
import { findBestItemMatch, matchesWholeWord } from "./fuzzy.js";
import { deriveVarietyQuery } from "./varietyQuery.js";
import type { Database } from "./types.js";
import {
  getCart,
  getProductFull,
  searchFirstPage,
  type WooliesProductFull,
} from "./wooliesClient.js";

// Matches the existing single-item three-tier flow's own numbered-list cap
// (see the #woolworths-ordering workspace CLAUDE.md) -- kept as the size of
// the untrimmed `all_alternatives` a re-prompt falls back to, so re-showing
// "full" alternatives for one ingredient looks exactly like that existing
// single-item rendering, not a new shape.
const FULL_ALTERNATIVES_CAP = 5;

// Recipe-mode's own tighter cap on the *initial* numbered list per
// ingredient -- see the design conversation that produced this tool: fewer
// alternatives per ingredient makes sense once several ingredients share one
// reply, and this is what "exactly 3 numbered alternatives + 1 best-value"
// means in the tool's own description.
const TRIMMED_ALTERNATIVES_CAP = 3;

// Soft internal deadline for the whole needed-ingredient resolution loop --
// checked before starting each ingredient, not mid-resolution (simpler than
// cancelling an in-flight call, and avoids ever returning half-resolved data
// for one ingredient). Set well under the REAL constraint that actually
// matters here: the MCP protocol's own client-side default request timeout
// is 60s (DEFAULT_REQUEST_TIMEOUT_MSEC in the SDK), confirmed live via a
// direct MCP client call -- not discordbot-host's much longer 300s
// container-kill, which this was originally (wrongly) budgeted against.
// A call that runs past 60s gets killed by the MCP layer with NO response
// at all, regardless of how close staples-host itself was to finishing --
// exactly the "3 attempts, no response" symptom this constant exists to
// prevent. See CLAUDE.md for the full timeline (first fix targeted the
// wrong ceiling; this value and the best-value removal above are the
// correction).
const TIME_BUDGET_MS = 45_000;

export interface ShoppingListAlternative {
  number: number;
  name: string;
  sku: string;
  price: number | null;
  recommended: boolean;
}

export interface ShoppingListFullAlternative {
  name: string;
  sku: string;
  price: number | null;
  recommended: boolean;
}

export interface ShoppingListEntry {
  ingredient: string;
  already_stocked: boolean;
  matched_item: string | null;
  tier: "history" | "cart" | "search" | "none" | null;
  alternatives: ShoppingListAlternative[];
  all_alternatives: ShoppingListFullAlternative[];
}

export interface ShoppingListResult {
  items: ShoppingListEntry[];
  // Present (true) only if the time budget was hit before every needed
  // ingredient could be resolved -- see not_attempted for which ones.
  partial?: boolean;
  not_attempted?: string[];
}

function toFullAlternative(a: RankedAlternative | WooliesProductFull, recommended: boolean): ShoppingListFullAlternative {
  return { name: a.name, sku: a.sku, price: a.price, recommended };
}

/**
 * Tier 1: purchase history, via the same rankAlternatives() suggest_alternatives
 * already uses -- identical ranking, identical live-search backfill. No
 * best-value here -- see CLAUDE.md: removed entirely from this tool once the
 * real 60s MCP request-timeout ceiling was confirmed, since it was the
 * dominant per-ingredient cost even in its cheaper fastMode form. Still
 * available from the single-item flow (suggest_alternatives/get_best_value),
 * which isn't time-constrained the same way -- ask about one item directly
 * to get it.
 */
async function resolveFromHistory(
  db: Database,
  ingredient: string,
): Promise<{ all: ShoppingListFullAlternative[] } | null> {
  const item = findBestItemMatch(db.items, ingredient);
  if (!item) return null;

  const events = db.purchase_events
    .filter((e) => e.item_id === item.item_id && e.product_name)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  const { candidates } = await rankAlternatives(events);
  if (candidates.length === 0) return null;

  const all = candidates
    .slice(0, FULL_ALTERNATIVES_CAP)
    .map((c, i) => toFullAlternative(c, i === 0));
  return { all };
}

/**
 * Tier 2: cart-narrowed search -- find a cart line plausibly matching the
 * ingredient (same whole-word check fuzzy.ts uses for staples, reused here
 * against live cart-line names), narrow the query via the same
 * deriveVarietyQuery() best-value already uses (e.g. "Mainland Cheese Edam
 * 500g" -> "Cheese Edam", exactly the "distinguishing brand/variety words"
 * the prior prompt-only version described). No best-value here -- see
 * resolveFromHistory's comment above.
 */
async function resolveFromCart(
  ingredient: string,
): Promise<{ all: ShoppingListFullAlternative[] } | null> {
  const cart = await getCart();
  const matches = cart.filter((line) => matchesWholeWord(ingredient, line.name));
  if (matches.length === 0) return null;
  // Longest name wins if more than one cart line plausibly matches -- same
  // "most specific match" tie-break fuzzy.ts's own forward pass uses.
  const cartLine = matches.reduce((best, m) => (m.name.length > best.name.length ? m : best));

  const full = await getProductFull(cartLine.sku);
  if (!full) return null;

  const narrowedQuery = deriveVarietyQuery(full.name, full.brand) || ingredient;
  const results = await searchFirstPage(narrowedQuery);
  const all = results.slice(0, FULL_ALTERNATIVES_CAP).map((r) => toFullAlternative(r, false));
  return { all };
}

/**
 * Tier 3: today's broad, unnarrowed search -- last resort, same reasoning as
 * the single-item flow's own Tier 3. No best-value here -- see
 * resolveFromHistory's comment above.
 */
async function resolveFromSearch(ingredient: string): Promise<{ all: ShoppingListFullAlternative[] } | null> {
  const results = await searchFirstPage(ingredient);
  if (results.length === 0) return null;

  const all = results.slice(0, FULL_ALTERNATIVES_CAP).map((r) => toFullAlternative(r, false));
  return { all };
}

/**
 * Resolves and globally numbers alternatives for a multi-ingredient shopping
 * list (e.g. from a recipe) in one call -- see build_shopping_list's tool
 * description for the full contract this produces. Runs the same
 * three-tier fallback the single-item "Choosing a Product Among Multiple
 * Matches" flow already uses, per ingredient. See CLAUDE.md for the full
 * performance history: a real 14-ingredient recipe first timed out
 * completely against the real constraint here (the MCP protocol's own 60s
 * client-side request timeout, not discordbot-host's much longer 300s
 * container-kill this was originally, wrongly, budgeted against);
 * findBestValue's cost (confirmed live as the dominant per-ingredient cost,
 * up to ~27s of one ingredient's ~32s) is now removed from this tool
 * entirely rather than merely made cheaper, since even its cheaper
 * "fastMode" form couldn't reliably clear the real 60s ceiling for a
 * realistic ingredient count -- best-value stays available from the
 * single-item flow, which isn't time-constrained the same way.
 */
export async function buildShoppingList(db: Database, ingredients: string[]): Promise<ShoppingListResult> {
  const { needed, alreadyStocked } = classifyIngredients(db.items, ingredients);

  const items: ShoppingListEntry[] = alreadyStocked.map((s) => ({
    ingredient: s.ingredient,
    already_stocked: true,
    matched_item: s.matched_item,
    tier: null,
    alternatives: [],
    all_alternatives: [],
  }));

  let nextNumber = 1;
  const startedAt = Date.now();
  const notAttempted: string[] = [];

  for (const n of needed) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      notAttempted.push(n.ingredient);
      continue;
    }

    let tier: ShoppingListEntry["tier"] = "none";
    let all: ShoppingListFullAlternative[] = [];

    const history = await resolveFromHistory(db, n.ingredient);
    if (history) {
      tier = "history";
      ({ all } = history);
    } else {
      const cart = await resolveFromCart(n.ingredient);
      if (cart) {
        tier = "cart";
        ({ all } = cart);
      } else {
        const search = await resolveFromSearch(n.ingredient);
        if (search) {
          tier = "search";
          ({ all } = search);
        }
      }
    }

    const trimmed = all.slice(0, TRIMMED_ALTERNATIVES_CAP);
    const alternatives: ShoppingListAlternative[] = trimmed.map((a) => ({
      number: nextNumber++,
      name: a.name,
      sku: a.sku,
      price: a.price,
      recommended: a.recommended,
    }));

    items.push({
      ingredient: n.ingredient,
      already_stocked: false,
      matched_item: n.matched_item,
      tier,
      alternatives,
      all_alternatives: all,
    });
  }

  if (notAttempted.length > 0) {
    return { items, partial: true, not_attempted: notAttempted };
  }
  return { items };
}
