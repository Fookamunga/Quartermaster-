import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { rankAlternatives, type RankedAlternative } from "../alternatives.js";
import { findBestValue } from "../bestValue.js";
import { findBestItemMatch } from "../fuzzy.js";
import { readDb } from "../storage.js";
import { resolveFromCartTier, resolveFromSearchTier } from "../tieredSearch.js";
import { type WooliesProductFull } from "../wooliesClient.js";
import { toolJson } from "./shared.js";

// Matches Tier 1's own existing numbered-candidate cap (MAX_OTHER_CANDIDATES
// in alternatives.ts) -- Tier 2/3 get the same display size, no new ranking
// logic, just truncate to whatever search_products returned first.
const MAX_CANDIDATES = 5;

function toRanked(p: WooliesProductFull): RankedAlternative {
  return { name: p.name, sku: p.sku, price: p.price };
}

export function registerSuggestAlternatives(server: McpServer): void {
  server.registerTool(
    "suggest_alternatives",
    {
      title: "Suggest alternatives",
      description:
        "The only tool for resolving a generic item name (e.g. 'cheese', " +
        "'chilli', 'what's the cheapest milk') to real, priced Woolworths " +
        "products -- this agent has no direct search/browse tool of its own " +
        "(search_products, browse_category, etc. are intentionally not " +
        "exposed here; see CLAUDE.md's Architecture section for why), so " +
        "call this for any request about finding, comparing, or pricing a " +
        "product to buy, not just 'add X' phrasing -- 'cheapest X', 'best " +
        "value X', 'what X should I get' all resolve through this tool too, " +
        "the same as 'add X' does. Never tell the user a product search " +
        "can't be done; this tool covers it, including for an item with no " +
        "purchase history or no existing staple record at all -- it runs a " +
        "live catalogue search server-side in that case, and does not " +
        "create a tracked staple as a side effect of just answering a " +
        "search/pricing question. Only create one via add_staple if the " +
        "user explicitly asks to start tracking the item.\n\n" +
        "Given a generic item name, resolves it via a three-tier fallback, " +
        "using whichever tier actually produces results, and returns " +
        "`tier` ('history' | 'cart' | 'search' | 'none') alongside the " +
        "result so the caller knows which applies:\n" +
        "- **'history'**: fuzzy-matches item_name against the staples list, " +
        "re-resolves up to the 10 most recent purchase_events with a " +
        "product_name to live products, dedupes by resolved sku/variantKey " +
        "(not raw text, which varies across receipts/orders for the same " +
        "real product), and ranks by frequency within that window with " +
        "recency as the tiebreaker. `top_pick` ({name, sku, price}) is a " +
        "genuinely ranked result backed by real purchase frequency -- mark " +
        "it ✅. `other_candidates` holds up to 4 more, same shape.\n" +
        "- **'cart'**: only reached if 'history' found nothing (not a " +
        "tracked staple, no purchase history with a product_name, or " +
        "nothing historical still resolves). Looks for a current cart line " +
        "plausibly matching item_name, narrows a live search using that " +
        "line's own brand/variety words, and returns the narrowed results " +
        "in `other_candidates` (up to 5) with `top_pick` left null -- " +
        "there's no purchase-frequency signal here, just search relevance, " +
        "so nothing should be marked ✅ or otherwise implied as " +
        "recommended.\n" +
        "- **'search'**: only reached if 'cart' also found nothing (nothing " +
        "in the cart plausibly matches either). A broad, unnarrowed live " +
        "search against item_name -- same `other_candidates`-only shape as " +
        "'cart', same no-recommendation rule.\n" +
        "- **'none'**: nothing resolved at all across all three tiers -- " +
        "say so plainly, don't invent an option.\n\n" +
        "Also returns a `best_value` entry ({name, pricePerUnit}) when " +
        "computable: the cheapest same-variety option across any brand, " +
        "anchored on whichever product is the real, known anchor for " +
        "whichever tier fired -- `top_pick` for 'history', the matched " +
        "**cart item itself** (not the narrowed search's own top result) " +
        "for 'cart', or the top search result for 'search'. Shown for every " +
        "tier, not just 'history' -- unlike the ✅ marker, best-value is " +
        "never a recommendation claim, just a factual \"cheapest in this " +
        "variety\" statement that holds regardless of which real product " +
        "it's anchored on. A best-effort suggestion, not an authoritative " +
        "cheapest-available claim (see CLAUDE.md) -- present it as such. " +
        "Omitted (not guessed) when nothing usable is found. Read-only: " +
        "never touches the cart, never places an order, never creates or " +
        "modifies a staple.",
      inputSchema: {
        item_name: z.string().min(1).describe("Generic item name, e.g. 'cheese'"),
      },
    },
    async ({ item_name }) => {
      const db = await readDb();

      // Tier 1: purchase history. Only reachable when item_name matches a
      // tracked staple with resolvable purchase_events -- rankAlternatives
      // returns an empty candidate list otherwise, and we fall through.
      const item = findBestItemMatch(db.items, item_name);
      if (item) {
        const events = db.purchase_events
          .filter((e) => e.item_id === item.item_id && e.product_name)
          .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

        const { candidates, topPickFull } = await rankAlternatives(events);
        if (candidates.length > 0) {
          const [topPick, ...otherCandidates] = candidates;
          const bestValue = topPickFull ? await findBestValue(topPickFull) : null;
          return toolJson({
            tier: "history",
            top_pick: topPick,
            other_candidates: otherCandidates,
            ...(bestValue ? { best_value: bestValue } : {}),
          });
        }
      }

      // Tier 2: cart-narrowed search. Covers both "tracked staple, no
      // purchase history yet" and "no staple record at all" -- neither case
      // gave Tier 1 anything to rank, and this tier needs no staple match of
      // its own, just a live cart to search against.
      const cartTier = await resolveFromCartTier(item_name);
      if (cartTier) {
        const otherCandidates = cartTier.results.slice(0, MAX_CANDIDATES).map(toRanked);
        const bestValue = await findBestValue(cartTier.cartItem);
        return toolJson({
          tier: "cart",
          top_pick: null,
          other_candidates: otherCandidates,
          ...(bestValue ? { best_value: bestValue } : {}),
        });
      }

      // Tier 3: broad, unnarrowed search -- last resort.
      const searchResults = await resolveFromSearchTier(item_name);
      if (searchResults) {
        const otherCandidates = searchResults.slice(0, MAX_CANDIDATES).map(toRanked);
        const bestValue = await findBestValue(searchResults[0]);
        return toolJson({
          tier: "search",
          top_pick: null,
          other_candidates: otherCandidates,
          ...(bestValue ? { best_value: bestValue } : {}),
        });
      }

      return toolJson({ tier: "none", top_pick: null, other_candidates: [] });
    },
  );
}
