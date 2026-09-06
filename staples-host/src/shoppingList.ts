import { rankAlternatives, type RankedAlternative } from "./alternatives.js";
import { findBestValue, type BestValueResult } from "./bestValue.js";
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
  best_value: BestValueResult | null;
}

export interface ShoppingListResult {
  items: ShoppingListEntry[];
}

function toFullAlternative(a: RankedAlternative | WooliesProductFull, recommended: boolean): ShoppingListFullAlternative {
  return { name: a.name, sku: a.sku, price: a.price, recommended };
}

/**
 * Tier 1: purchase history, via the same rankAlternatives() suggest_alternatives
 * already uses -- identical ranking, identical live-search backfill.
 */
async function resolveFromHistory(
  db: Database,
  ingredient: string,
): Promise<{ all: ShoppingListFullAlternative[]; bestValue: BestValueResult | null } | null> {
  const item = findBestItemMatch(db.items, ingredient);
  if (!item) return null;

  const events = db.purchase_events
    .filter((e) => e.item_id === item.item_id && e.product_name)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  const { candidates, topPickFull } = await rankAlternatives(events);
  if (candidates.length === 0) return null;

  const all = candidates
    .slice(0, FULL_ALTERNATIVES_CAP)
    .map((c, i) => toFullAlternative(c, i === 0));
  const bestValue = topPickFull ? await findBestValue(topPickFull) : null;
  return { all, bestValue };
}

/**
 * Tier 2: cart-narrowed search -- find a cart line plausibly matching the
 * ingredient (same whole-word check fuzzy.ts uses for staples, reused here
 * against live cart-line names), narrow the query via the same
 * deriveVarietyQuery() best-value already uses (e.g. "Mainland Cheese Edam
 * 500g" -> "Cheese Edam", exactly the "distinguishing brand/variety words"
 * the prior prompt-only version described), and anchor best-value on the
 * cart item itself, not the narrowed search's own top result -- see the
 * workspace CLAUDE.md's Tier 2 for why.
 */
async function resolveFromCart(
  ingredient: string,
): Promise<{ all: ShoppingListFullAlternative[]; bestValue: BestValueResult | null } | null> {
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
  const bestValue = await findBestValue(full);
  return { all, bestValue };
}

/**
 * Tier 3: today's broad, unnarrowed search -- last resort, same reasoning as
 * the single-item flow's own Tier 3. Anchors best-value on this search's own
 * top result, since there's no cart context to anchor on instead.
 */
async function resolveFromSearch(
  ingredient: string,
): Promise<{ all: ShoppingListFullAlternative[]; bestValue: BestValueResult | null } | null> {
  const results = await searchFirstPage(ingredient);
  if (results.length === 0) return null;

  const all = results.slice(0, FULL_ALTERNATIVES_CAP).map((r) => toFullAlternative(r, false));
  const bestValue = await findBestValue(results[0]);
  return { all, bestValue };
}

/**
 * Resolves and globally numbers alternatives for a multi-ingredient shopping
 * list (e.g. from a recipe) in one call -- see build_shopping_list's tool
 * description for the full contract this produces. Runs the same
 * three-tier fallback the single-item "Choosing a Product Among Multiple
 * Matches" flow already uses, per ingredient, sequentially (this is a single
 * low-traffic household service calling a shared external dependency --
 * same reasoning as rankAlternatives' own sequential resolution).
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
    best_value: null,
  }));

  let nextNumber = 1;
  for (const n of needed) {
    let tier: ShoppingListEntry["tier"] = "none";
    let all: ShoppingListFullAlternative[] = [];
    let bestValue: BestValueResult | null = null;

    const history = await resolveFromHistory(db, n.ingredient);
    if (history) {
      tier = "history";
      ({ all, bestValue: bestValue } = history);
    } else {
      const cart = await resolveFromCart(n.ingredient);
      if (cart) {
        tier = "cart";
        ({ all, bestValue } = cart);
      } else {
        const search = await resolveFromSearch(n.ingredient);
        if (search) {
          tier = "search";
          ({ all, bestValue } = search);
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
      best_value: bestValue,
    });
  }

  return { items };
}
