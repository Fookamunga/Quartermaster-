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
 *
 * Also strips a bare "&" -- real product names often use it as a connector
 * between two adjectives (e.g. "Thick & Large", "Thick & Creamy"), which is
 * harmless while both flanking words are still present, but becomes a
 * problem once searchVariety's word-count trimming works its way down to
 * it: "&" occupies a word slot but the search backend can't match on it as
 * content, so a query like "Thick &" effectively degrades to a single bare
 * adjective ("Thick") while still *counting* as 2 words toward
 * MIN_QUERY_WORDS. Confirmed live: "Sorbent Thick & Large Toilet Paper 8pk
 * Silky White" trimmed down to "Thick &" this way, which matched 22
 * completely unrelated products (yoghurt, aioli) purely because they also
 * contain the word "Thick" -- surfaced as suggest_alternatives("toilet
 * paper") reporting a fruit bread as its "best value" alternative. Without
 * the bare "&", the same trimming floors out one step earlier at "Thick
 * Large" instead, which stays genuinely paper/tissue-dominated (still not
 * perfect -- see CLAUDE.md: this stays a best-effort heuristic, not a
 * guarantee).
 */
export function deriveVarietyQuery(name: string, brand: string | null): string {
  let s = name;
  if (brand) {
    s = s.replace(new RegExp(`\\b${escapeRegExp(brand)}\\b`, "i"), "");
  }
  s = s.replace(/\b\d+(\.\d+)?\s*(g|kg|ml|l)\b/gi, "");
  s = s.replace(/\s*&\s*/g, " ");
  return s.replace(/\s+/g, " ").trim();
}
