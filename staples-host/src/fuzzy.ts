import Fuse from "fuse.js";
import { FUZZY_MATCH_THRESHOLD } from "./config.js";
import type { Item } from "./types.js";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whole-word substring match: does this item's name appear as a complete
 * word (or word sequence) inside the query? This is the direction Fuse's
 * length-normalized edit-distance score handles badly by default: a long
 * query (a real receipt/order line, e.g. "Woolworths Bread Wholemeal 700g")
 * against a short target (a generic staple name, e.g. "Bread") scores as no
 * match at all under Fuse -- confirmed by direct testing, and not fixable
 * via ignoreLocation/distance tuning, since the penalty comes from the
 * length mismatch itself, not match position. \b-anchored so "Rice" doesn't
 * match inside "apprice" or a compound word like "Gingerbread" (no word
 * boundary immediately before "bread" there).
 */
function findWholeWordSubstringMatch(items: Item[], query: string): Item | null {
  const matches = items.filter((item) =>
    new RegExp(`\\b${escapeRegExp(item.name)}\\b`, "i").test(query),
  );
  if (matches.length === 0) return null;
  // More than one staple's name can appear in the query (e.g. both "Milk"
  // and "Oat Milk" as tracked staples, against a line mentioning oat milk)
  // -- the longest (most specific) match wins.
  return matches.reduce((best, m) => (m.name.length > best.name.length ? m : best));
}

/**
 * Fuzzy-match a free-text name against the item list (handles receipt OCR
 * noise, plurals, abbreviations, etc.). Returns null if nothing matches.
 *
 * Three passes, in order: exact match, then whole-word substring match
 * (handles a short generic staple name appearing inside a long, verbose
 * real product line -- the common case for actual receipts/orders), then
 * Fuse's edit-distance fuzzy search as a fallback for near-matches/typos
 * that don't have a clean substring relationship (Fuse's own strength, and
 * the direction it already handled correctly -- a short query like "oat
 * milk" against a longer canonical item name).
 */
export function findBestItemMatch(
  items: Item[],
  query: string,
): Item | null {
  const exact = items.find(
    (i) => i.name.trim().toLowerCase() === query.trim().toLowerCase(),
  );
  if (exact) return exact;

  const wholeWord = findWholeWordSubstringMatch(items, query);
  if (wholeWord) return wholeWord;

  const fuse = new Fuse(items, {
    keys: ["name"],
    includeScore: true,
    threshold: FUZZY_MATCH_THRESHOLD,
  });
  const [best] = fuse.search(query);
  return best ? best.item : null;
}
