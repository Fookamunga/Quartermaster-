import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { rankAlternatives } from "../alternatives.js";
import { findBestValue } from "../bestValue.js";
import { findBestItemMatch } from "../fuzzy.js";
import { readDb } from "../storage.js";
import { toolJson } from "./shared.js";

export function registerSuggestAlternatives(server: McpServer): void {
  server.registerTool(
    "suggest_alternatives",
    {
      title: "Suggest alternatives",
      description:
        "Given a generic item name (e.g. 'cheese'), resolve and rank real product " +
        "alternatives from purchase history. Fuzzy-matches item_name against the " +
        "staples list, takes up to the 10 most recent purchase_events with a " +
        "product_name, re-resolves each to a live Woolworths product via " +
        "woolies-mcp's own search_products, dedupes by resolved sku/variantKey " +
        "(not raw text, which varies across receipts/orders for the same real " +
        "product), and ranks by frequency within that window with recency as the " +
        "tiebreaker. Returns top_pick ({name, sku, price} or null) -- the #1-ranked " +
        "result, called out as its own explicit field rather than left as array " +
        "position 0, so a caller can't lose track of which one it is -- plus " +
        "other_candidates (up to 4 more, same shape). Both empty/null (never a " +
        "guess) if item_name isn't a tracked staple, has no purchase history with " +
        "a product_name, or nothing historical resolves to a live product " +
        "anymore. Also returns a best_value entry ({name, pricePerUnit}) when " +
        "computable: the cheapest same-variety option across any brand, not just " +
        "top_pick's own -- a best-effort suggestion, not an authoritative " +
        "cheapest-available claim (see CLAUDE.md). Omitted (not guessed) when " +
        "nothing usable is found. Read-only: never touches the cart, never " +
        "places an order.",
      inputSchema: {
        item_name: z.string().min(1).describe("Generic item name, e.g. 'cheese'"),
      },
    },
    async ({ item_name }) => {
      const db = await readDb();
      const item = findBestItemMatch(db.items, item_name);
      if (!item) {
        return toolJson({ top_pick: null, other_candidates: [] });
      }

      const events = db.purchase_events
        .filter((e) => e.item_id === item.item_id && e.product_name)
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

      const { candidates, topPickFull } = await rankAlternatives(events);
      if (candidates.length === 0) {
        return toolJson({ top_pick: null, other_candidates: [] });
      }

      const [topPick, ...otherCandidates] = candidates;
      const bestValue = topPickFull ? await findBestValue(topPickFull) : null;
      return toolJson({
        top_pick: topPick,
        other_candidates: otherCandidates,
        ...(bestValue ? { best_value: bestValue } : {}),
      });
    },
  );
}
