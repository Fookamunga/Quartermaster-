// Best-effort exclusion heuristic, not a guarantee -- see CLAUDE.md's
// suggest_alternatives entry. A variety-wide search mixes genuinely
// comparable products with superficially similar ones that happen to share
// words (confirmed live: "edam cheese" returned cracker-and-cheese snack
// combos alongside real cheese; "toilet paper" -> "Thick Large" returned
// Dash Hair Ties alongside real toilet paper). There's no structural field
// to filter on (all shared the same department in testing), so this
// excludes a result only if its name contains one of these category-mixing
// words AND the top pick's own name doesn't -- deliberately short and
// conservative rather than an attempt at exhaustive category detection.
//
// Shared by bestValue.ts (excluding a bad best-value anchor) and
// alternatives.ts's live-search backfill (excluding a bad numbered
// candidate) -- confirmed live these needed the exact same fix: bestValue.ts
// already excluded "Dash Hair Ties Elastic..." from best-value contention,
// but alternatives.ts's backfill had no equivalent filter at all, so the
// same unrelated product still reached the numbered other_candidates list
// (and, in real use, got picked by mistake).
export const SUSPECT_WORDS = [
  "cracker",
  "crackers",
  "snack",
  "biscuit",
  "biscuits",
  "chip",
  "chips",
  "dip",
  "elastic",
];

export function hasSuspectWord(name: string, topPickName: string): boolean {
  const topWords = new Set(topPickName.toLowerCase().split(/\W+/));
  const nameWords = name.toLowerCase().split(/\W+/);
  return nameWords.some((w) => SUSPECT_WORDS.includes(w) && !topWords.has(w));
}
