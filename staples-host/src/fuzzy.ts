import Fuse from "fuse.js";
import { FUZZY_MATCH_THRESHOLD } from "./config.js";
import type { Item } from "./types.js";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Modifier words that, placed directly next to a matched staple name, turn
// it into a genuinely different product or flavor rather than a description
// of the staple itself -- e.g. "peanut butter" is a different product from
// the dairy "Butter" staple, and "sea salt"/"garlic salt" are flavor
// descriptors, not a plain "Salt" purchase. Confirmed live against real
// production data: before this list existed, "Harvest snaps pea crisps salt
// & vinegar 120g", "Pico organic chocolate bar sea salt 80g", and "Pics
// peanut butter crunchy 380g" all wrongly recorded purchases against
// "Salt"/"Butter". This is a curated, living list, not a closed set --
// extend it whenever a new false-positive pattern like this turns up,
// same as bestValue.ts's SUSPECT_WORDS. It's deliberately a list rather than
// an automatic rule: real data ruled out every positional/proportional
// alternative tried (e.g. "how much of the product name the staple word
// accounts for") -- "Ploughmans bakery toast bread country grains 750g" is a
// perfectly genuine "Bread" match with the *same* word-count/position shape
// as the bad "Salt" matches above, so no structural signal alone tells them
// apart; only the specific adjacent word does.
const COMPOUND_MODIFIER_WORDS = new Set([
  "peanut", "almond", "cashew", "hazelnut", "cocoa", "shea", // -> nut/cocoa butters, not dairy butter
  "sea", "garlic", "onion", "celery", "seasoned", "rock", "himalayan", // -> flavored salt
  "brown", "icing", "caster", "raw", "coconut", // -> sugar variants
  "bell", "chilli", "chili", "scotch", // -> pepper variants (not currently tracked, added defensively)
]);

/**
 * The word (or bare "&"/"and") immediately before and after `itemName`'s
 * match inside `query`, lowercased -- null at either end if the match is at
 * the start/end of the query. Used to reject a whole-word substring match
 * that's actually an incidental flavor/descriptor mention rather than the
 * product itself; see COMPOUND_MODIFIER_WORDS above.
 */
function neighborWords(
  query: string,
  itemName: string,
): { before: string | null; after: string | null } | null {
  const re = new RegExp(`(?:(\\S+)\\s+)?\\b${escapeRegExp(itemName)}\\b(?:\\s+(\\S+))?`, "i");
  const match = re.exec(query);
  if (!match) return null;
  return {
    before: match[1]?.toLowerCase() ?? null,
    after: match[2]?.toLowerCase() ?? null,
  };
}

function isFlavorPairingOrCompound(before: string | null, after: string | null): boolean {
  if (before === "&" || before === "and" || after === "&" || after === "and") return true;
  if (before && COMPOUND_MODIFIER_WORDS.has(before)) return true;
  return false;
}

/**
 * Does `itemName` appear as a complete word (or word sequence) inside
 * `query`, and -- if so -- is it a genuine mention rather than an incidental
 * flavor/descriptor one (see COMPOUND_MODIFIER_WORDS)? Factored out of
 * findWholeWordSubstringMatch so build_shopping_list's Tier 2 can reuse the
 * exact same check against a live cart-line name, not just tracked
 * `Item[]` -- e.g. does the ingredient "cheese" plausibly appear in a real
 * cart line like "Mainland Cheese Edam 500g"?
 */
export function matchesWholeWord(itemName: string, query: string): boolean {
  const neighbors = neighborWords(query, itemName);
  if (!neighbors) return false;
  return !isFlavorPairingOrCompound(neighbors.before, neighbors.after);
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
 *
 * Also rejects a match whose immediate neighbor word makes it an incidental
 * flavor/descriptor mention rather than the actual product -- see
 * COMPOUND_MODIFIER_WORDS.
 */
function findWholeWordSubstringMatch(items: Item[], query: string): Item | null {
  const matches = items.filter((item) => matchesWholeWord(item.name, query));
  if (matches.length === 0) return null;
  // More than one staple's name can appear in the query (e.g. both "Milk"
  // and "Oat Milk" as tracked staples, against a line mentioning oat milk)
  // -- the longest (most specific) match wins.
  return matches.reduce((best, m) => (m.name.length > best.name.length ? m : best));
}

/**
 * Reverse of the above: does the QUERY appear as a whole word/phrase inside
 * a longer item name? Needed because a tracked staple isn't always named
 * with a short generic category -- confirmed live, a real staple named
 * "Otis oat milk the everyday one" was invisible to a plain "milk" lookup
 * (suggest_alternatives, get_item, and record_purchase all take a short
 * name and need to find whichever staple it refers to), since the forward
 * check above only handles a short ITEM name inside a long query, not a
 * short QUERY inside a long item name.
 *
 * No COMPOUND_MODIFIER_WORDS-style gate here: this is the read/lookup
 * direction (or a purchase recorded against an explicitly-typed name), not
 * blind text-mining of a noisy receipt line, so the false-positive risk
 * bug #2 was about doesn't apply the same way -- just a guard against the
 * query itself being a stray filler word (e.g. "the", long enough that a
 * bare length check wouldn't catch it) that happens to appear inside a long
 * item name, e.g. "...the everyday one".
 */
const REVERSE_MATCH_STOPWORDS = new Set([
  "the", "and", "for", "with", "of", "one", "a", "an", "in", "on", "to", "is",
]);

function findWholeWordSubstringMatchReverse(items: Item[], query: string): Item | null {
  const trimmed = query.trim();
  if (trimmed.length < 3 || REVERSE_MATCH_STOPWORDS.has(trimmed.toLowerCase())) return null;

  const matches = items.filter((item) =>
    new RegExp(`\\b${escapeRegExp(trimmed)}\\b`, "i").test(item.name),
  );
  if (matches.length === 0) return null;
  // Shortest item name wins -- the closest, least-embellished match to what
  // was actually typed, if more than one tracked staple's full name happens
  // to contain the query term.
  return matches.reduce((best, m) => (m.name.length < best.name.length ? m : best));
}

/**
 * Fuzzy-match a free-text name against the item list (handles receipt OCR
 * noise, plurals, abbreviations, etc.). Returns null if nothing matches.
 *
 * Four passes, in order: exact match; forward whole-word substring match
 * (a short generic staple name appearing inside a long, verbose real
 * product line -- the common case for actual receipts/orders); reverse
 * whole-word substring match (a short lookup query appearing inside a
 * longer, more specific staple name); then Fuse's edit-distance fuzzy
 * search as a fallback for near-matches/typos that don't have a clean
 * substring relationship in either direction.
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

  const reverseWholeWord = findWholeWordSubstringMatchReverse(items, query);
  if (reverseWholeWord) return reverseWholeWord;

  return findFuzzyFallbackMatch(items, query);
}

// How short a query can be, relative to the matched item's own name length,
// before its Fuse score is trusted -- confirmed live: "lime" (4 chars)
// scored 0.386 against the real staple "Olive oil" (9 chars, ratio 0.44),
// under FUZZY_MATCH_THRESHOLD yet a wrong match; "spagetti" (8 chars, a
// realistic typo) against "Spaghetti pasta" (15 chars, ratio 0.53) is a
// genuine correction worth keeping. 0.5 cleanly separates the two in every
// case tested against the real staples list -- like COMPOUND_MODIFIER_WORDS,
// this is an evidence-based cutoff, not a fixed law; revisit if real data
// argues otherwise.
const MIN_QUERY_TO_NAME_LENGTH_RATIO = 0.5;

/**
 * Fuse's edit-distance fallback for near-matches/typos with no clean
 * substring relationship in either direction (see findBestItemMatch).
 *
 * Does NOT rely on Fuse's own `threshold` option to gate results -- confirmed
 * live that it doesn't reliably do so: searching the real 13-item staples
 * list for "otiss" returns "Otis oat milk the everyday one" at score 0.519
 * and "sos" returns "Soy sauce" at 0.46, both returned even though both
 * scores exceed a configured threshold of 0.4. Fuse is called here with a
 * permissive threshold instead (so it always reports its true best score),
 * and this function applies its own two checks explicitly: the score must
 * still clear FUZZY_MATCH_THRESHOLD, and the query must be at least
 * MIN_QUERY_TO_NAME_LENGTH_RATIO of the matched name's length -- a short
 * query fuzzy-matching a much longer, mostly-unrelated name (e.g. "lime"
 * against "Olive oil") is exactly the shape of false positive neither the
 * threshold alone nor Fuse's internal gating catches.
 */
function findFuzzyFallbackMatch(items: Item[], query: string): Item | null {
  const fuse = new Fuse(items, { keys: ["name"], includeScore: true, threshold: 1 });
  const [best] = fuse.search(query);
  if (!best || best.score == null) return null;
  if (best.score > FUZZY_MATCH_THRESHOLD) return null;

  const ratio = query.trim().length / best.item.name.length;
  if (ratio < MIN_QUERY_TO_NAME_LENGTH_RATIO) return null;

  return best.item;
}
