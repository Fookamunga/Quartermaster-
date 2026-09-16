import type { PurchaseEvent } from "./types.js";
import { deriveVarietyQuery } from "./varietyQuery.js";
import { hasSuspectWord } from "./varietyFilter.js";
import { searchTopProductFull, searchVariety, type WooliesProductFull } from "./wooliesClient.js";

// See CLAUDE.md's suggest_alternatives entry and the #woolworths-ordering
// workspace CLAUDE.md's "Choosing a Product Among Multiple Matches" for the
// full three-tier design this is Tier 1 of.
const HISTORY_WINDOW = 10;

// Count of *other* candidates shown in the numbered list, alongside (not
// including) the ✅ top pick -- up to MAX_OTHER_CANDIDATES + 1 real products
// total. Widened from an earlier design where this was "5 total including
// top pick" (4 others) once Tier 2/3 were capped at 5 numbered candidates
// each -- Tier 1 should offer the same 5 numbered options, on top of its
// own ✅ pick, not fewer just because it has one.
const MAX_OTHER_CANDIDATES = 5;

export interface RankedAlternative {
  name: string;
  sku: string;
  price: number | null;
}

export interface RankedAlternativesResult {
  candidates: RankedAlternative[];
  // Full data for the #1-ranked candidate specifically (brand, unitPrice
  // included) -- null whenever candidates is empty. Callers (e.g.
  // suggest_alternatives) use this to compute the best-value entry without
  // a duplicate lookup; ranking itself never needs these extra fields.
  topPickFull: WooliesProductFull | null;
}

interface Candidate {
  product: WooliesProductFull;
  frequency: number;
  mostRecentDate: string;
}

function toRankedAlternative(product: WooliesProductFull): RankedAlternative {
  return { name: product.name, sku: product.sku, price: product.price };
}

/**
 * Fills remaining numbered-list slots via a live same-variety search when
 * purchase history alone doesn't have enough distinct resolved products --
 * e.g. a real household that's only ever bought one specific oat milk
 * product has no other historical candidates to rank, but the numbered
 * list should still offer real options alongside the ✅ pick. Uses the same
 * variety-query derivation findBestValue already uses (deriveVarietyQuery)
 * via the shared searchVariety() broadening search, so this genuinely
 * reflects "other products like the ✅ pick," not an arbitrary search.
 *
 * Takes results in the search's own relevance order -- no new ranking
 * logic, same as Tier 2/3's own numbered lists -- skipping anything already
 * *shown* (the ✅ pick itself, or a historical candidate already in the
 * list; not the full history-window ranked list, which may hold more
 * candidates than fit the display cap), so nothing appears twice. Never
 * fabricates: a connection failure or a variety search that finds nothing
 * usable just means fewer than MAX_OTHER_CANDIDATES are shown, not a
 * fabricated filler.
 *
 * Also excludes a result if its name carries a `hasSuspectWord` hit against
 * `topPick` -- a real, live gap, not a defensive addition: bestValue.ts
 * already applied this exact filter when picking a best-value anchor, but
 * this backfill (filling the *numbered* other_candidates list) had no
 * equivalent check at all, so the same unrelated product it correctly
 * excluded from best-value could still show up here instead. Confirmed
 * live: "toilet paper" -> "Thick Large" backfill surfaced "Dash Hair Ties
 * Elastic Large Thick" as two of five numbered candidates -- and in real
 * use, one of them got picked by mistake, since a numbered list gives no
 * signal that an entry is any less trustworthy than the others.
 */
async function backfillFromLiveSearch(
  topPick: WooliesProductFull,
  alreadyShown: Set<string>,
  needed: number,
): Promise<RankedAlternative[]> {
  if (needed <= 0) return [];

  const varietyQuery = deriveVarietyQuery(topPick.name, topPick.brand);
  if (!varietyQuery) return [];

  let results: WooliesProductFull[];
  try {
    results = await searchVariety(varietyQuery);
  } catch {
    return []; // connection/protocol failure -- degrade to whatever history already had
  }

  const filled: RankedAlternative[] = [];
  for (const r of results) {
    if (filled.length >= needed) break;
    if (alreadyShown.has(r.variantKey)) continue;
    if (hasSuspectWord(r.name, topPick.name)) continue;
    filled.push(toRankedAlternative(r));
  }
  return filled;
}

/**
 * Resolves and ranks alternatives from a caller-supplied, already-sorted
 * (most-recent-first), already-product_name-filtered event list. Resolves
 * sequentially, not in parallel -- this is a single low-traffic household
 * service calling a shared external dependency; there's no need to open up
 * to 10 concurrent connections to woolies-mcp for one request.
 *
 * Resolves once per *distinct* product_name text, not once per event --
 * repeat-buying the same product is the common case for a staple, and a
 * repeated event is guaranteed to resolve identically (same input string,
 * same deterministic searchTopProductFull result), so re-running the
 * search is pure wasted latency, not a chance at a different answer. This
 * was a real, user-visible bug, not just an optimization: confirmed live,
 * "toilet paper"'s real history is 10 events across only 5 distinct
 * product_name strings (one repeated 5x, one 2x) -- resolving all 10
 * separately took 61s, blowing well past the warm session's 40s
 * per-tool-call ceiling and surfacing to the user as "it timed out twice,
 * I can't resolve it right now" for an item with nothing unusual about it
 * except being purchased often.
 */
export async function rankAlternatives(events: PurchaseEvent[]): Promise<RankedAlternativesResult> {
  const window = events.slice(0, HISTORY_WINDOW);

  const byName = new Map<string, PurchaseEvent[]>();
  for (const event of window) {
    const nameKey = (event.product_name as string).trim().toLowerCase();
    const group = byName.get(nameKey);
    if (group) group.push(event);
    else byName.set(nameKey, [event]);
  }

  const candidates = new Map<string, Candidate>();

  for (const group of byName.values()) {
    let resolved: WooliesProductFull | null;
    try {
      resolved = await searchTopProductFull(group[0].product_name as string);
    } catch {
      // A genuine connection/protocol failure resolving this one historical
      // name -- treated the same as "no longer in the catalogue" (skip this
      // candidate, keep going), not a failure of the whole tier. See
      // CLAUDE.md: only an empty final list means "nothing resolved".
      resolved = null;
    }
    if (!resolved) continue;

    const mostRecentInGroup = group.reduce((max, e) => (e.date > max ? e.date : max), group[0].date);
    const key = resolved.variantKey;
    const existing = candidates.get(key);
    if (existing) {
      existing.frequency += group.length;
      if (mostRecentInGroup > existing.mostRecentDate) existing.mostRecentDate = mostRecentInGroup;
    } else {
      candidates.set(key, { product: resolved, frequency: group.length, mostRecentDate: mostRecentInGroup });
    }
  }

  const ranked = [...candidates.values()].sort((a, b) => {
    if (b.frequency !== a.frequency) return b.frequency - a.frequency;
    // Tiebreaker only: more recent first.
    return a.mostRecentDate < b.mostRecentDate ? 1 : a.mostRecentDate > b.mostRecentDate ? -1 : 0;
  });

  const topEntry = ranked[0];
  const topPickFull = topEntry?.product ?? null;
  const historicalOthers = ranked.slice(1, 1 + MAX_OTHER_CANDIDATES);

  let otherCandidates = historicalOthers.map((c) => toRankedAlternative(c.product));

  if (topPickFull && otherCandidates.length < MAX_OTHER_CANDIDATES) {
    const needed = MAX_OTHER_CANDIDATES - otherCandidates.length;
    const alreadyShown = new Set([
      topPickFull.variantKey,
      ...historicalOthers.map((c) => c.product.variantKey),
    ]);
    const backfill = await backfillFromLiveSearch(topPickFull, alreadyShown, needed);
    otherCandidates = [...otherCandidates, ...backfill];
  }

  return {
    candidates: topPickFull ? [toRankedAlternative(topPickFull), ...otherCandidates] : [],
    topPickFull,
  };
}
