function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Derives a same-variety search query from a resolved product's own name +
 * brand -- strips the brand and a trailing size/weight pattern, e.g.
 * "Mainland Cheese Edam 500g" minus brand "Mainland" minus size "500g"
 * leaves "Cheese Edam". Shared between findBestValue (bestValue.ts) and
 * Tier 1's live-search backfill (alternatives.ts) -- both need "what's the
 * broader product category this specific item belongs to," just for
 * different purposes (cheapest-in-variety vs. more real options to show).
 *
 * This alone isn't always broad enough: a product whose brand's own
 * sub-line/product name is baked into the residual (e.g. Otis "Oat Milk The
 * Everyday One") still isn't a real shared category -- see
 * wooliesClient.ts's searchVariety() for the broadening step that handles
 * that, shared by both callers of this function.
 */
export function deriveVarietyQuery(name: string, brand: string | null): string {
  let s = name;
  if (brand) {
    s = s.replace(new RegExp(`\\b${escapeRegExp(brand)}\\b`, "i"), "");
  }
  s = s.replace(/\b\d+(\.\d+)?\s*(g|kg|ml|l)\b/gi, "");
  return s.replace(/\s+/g, " ").trim();
}
