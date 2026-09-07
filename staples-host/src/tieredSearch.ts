import { matchesWholeWord } from "./fuzzy.js";
import { deriveVarietyQuery } from "./varietyQuery.js";
import { getCart, getProductFull, searchFirstPage, type WooliesProductFull } from "./wooliesClient.js";

// Tier 2/3 of the single-item "Choosing a Product Among Multiple Matches"
// flow (see the #woolworths-ordering workspace CLAUDE.md), moved server-side
// so suggest_alternatives can run the whole three-tier resolution in one
// call instead of the agent doing Tier 2/3 itself via its own direct
// woolies-mcp search_products/get_cart calls. That agent-side design is what
// let "cheapest X"-style requests reach straight for search_products instead
// of suggest_alternatives -- two tools that both plausibly answer the same
// phrasing, with the agent free to pick either. Removing search_products
// from the agent's own tool list closes that off structurally, which only
// works because this tier's logic no longer depends on the agent holding a
// search tool at all. See CLAUDE.md's "Architecture" section.
//
// Neither tier requires item_name to match an existing tracked staple --
// that's the whole point: this is exactly the path a non-staple, one-off
// item (or a tracked staple with no purchase history yet) needs, and it was
// a real gap before this file existed (suggest_alternatives returned
// top_pick: null immediately for either case, with no fallback of its own).
// build_shopping_list already had equivalent logic for the same reason
// (needed items are rarely all tracked staples); this module exists so the
// single-item tool gets it too, without duplicating the cart/search calls
// twice in this codebase.

export interface CartTierResult {
  // Full details of the matched cart line itself -- the best-value anchor
  // for this tier (see bestValue.ts's caller): the cart item is the one
  // real, known product in this flow, unlike the narrowed search's own top
  // result, which is just relevance-ranking.
  cartItem: WooliesProductFull;
  results: WooliesProductFull[];
}

/**
 * Tier 2: find a cart line plausibly matching item_name, narrow a search via
 * its brand+size-stripped variety query, and return both the matched cart
 * item and the narrowed search's results. Null if nothing in the cart
 * plausibly matches, or the matched line's product no longer resolves.
 */
export async function resolveFromCartTier(itemName: string): Promise<CartTierResult | null> {
  const cart = await getCart();
  const matches = cart.filter((line) => matchesWholeWord(itemName, line.name));
  if (matches.length === 0) return null;

  // Longest name wins if more than one cart line plausibly matches -- same
  // "most specific match" tie-break fuzzy.ts's own forward pass uses.
  const cartLine = matches.reduce((best, m) => (m.name.length > best.name.length ? m : best));

  const cartItem = await getProductFull(cartLine.sku);
  if (!cartItem) return null;

  const narrowedQuery = deriveVarietyQuery(cartItem.name, cartItem.brand) || itemName;
  const results = await searchFirstPage(narrowedQuery);
  if (results.length === 0) return null;

  return { cartItem, results };
}

/**
 * Tier 3: today's broad, unnarrowed search -- last resort. Null if nothing
 * comes back at all.
 */
export async function resolveFromSearchTier(itemName: string): Promise<WooliesProductFull[] | null> {
  const results = await searchFirstPage(itemName);
  return results.length > 0 ? results : null;
}
