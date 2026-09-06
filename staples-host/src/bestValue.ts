import { deriveVarietyQuery } from "./varietyQuery.js";
import { searchVariety, searchVarietyFirstPageOnly, type WooliesProductFull } from "./wooliesClient.js";

export interface BestValueResult {
  name: string;
  pricePerUnit: string; // e.g. "$1.36/100g", already formatted for display
}

// Best-effort exclusion heuristic, not a guarantee -- see CLAUDE.md's
// suggest_alternatives entry. A variety-wide search mixes genuinely
// comparable products with superficially similar ones that happen to share
// words (confirmed live: "edam cheese" returned cracker-and-cheese snack
// combos alongside real cheese). There's no structural field to filter on
// (all shared the same department in testing), so this excludes a result
// only if its name contains one of these category-mixing words AND the top
// pick's own name doesn't -- deliberately short and conservative rather
// than an attempt at exhaustive category detection.
const SUSPECT_WORDS = ["cracker", "crackers", "snack", "biscuit", "biscuits", "chip", "chips", "dip"];

function hasSuspectWord(name: string, topPickName: string): boolean {
  const topWords = new Set(topPickName.toLowerCase().split(/\W+/));
  const nameWords = name.toLowerCase().split(/\W+/);
  return nameWords.some((w) => SUSPECT_WORDS.includes(w) && !topWords.has(w));
}

function parseUnitPrice(unitPrice: string | null): { value: number; unit: string } | null {
  if (!unitPrice) return null;
  const match = /\$([\d.]+)\s*\/\s*(.+)/.exec(unitPrice);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  return { value, unit: match[2].trim().toUpperCase() };
}

/**
 * Finds the cheapest same-variety (any brand) option relative to topPick,
 * or null if nothing usable is found -- never a guess. See CLAUDE.md's
 * suggest_alternatives entry: this is a best-effort suggestion, not an
 * authoritative cheapest-available claim.
 *
 * `fastMode` swaps the underlying search for searchVarietyFirstPageOnly --
 * confirmed live this cuts the dominant per-ingredient cost in
 * build_shopping_list (up to ~27s down to whatever the broadening probe
 * alone costs) at the price of a weaker, first-page-only comparison rather
 * than full-catalogue coverage. Worth it once per shopping-list ingredient;
 * not worth it for a single confident answer, so the single-item
 * disambiguation flow (suggest_alternatives/get_best_value) never sets it.
 */
export async function findBestValue(
  topPick: {
    name: string;
    brand: string | null;
    unitPrice: string | null;
  },
  options?: { fastMode?: boolean },
): Promise<BestValueResult | null> {
  const topParsed = parseUnitPrice(topPick.unitPrice);
  if (!topParsed) return null; // nothing to compare a variety search against

  const varietyQuery = deriveVarietyQuery(topPick.name, topPick.brand);
  if (!varietyQuery) return null;

  let candidates: WooliesProductFull[];
  try {
    candidates = options?.fastMode
      ? await searchVarietyFirstPageOnly(varietyQuery)
      : await searchVariety(varietyQuery);
  } catch {
    return null; // connection/protocol failure -- degrade to no best-value entry
  }
  if (candidates.length === 0) return null;

  const survivors = candidates.filter((c) => !hasSuspectWord(c.name, topPick.name));

  const parsedByDenomination = new Map<string, { product: WooliesProductFull; value: number }[]>();
  for (const c of survivors) {
    const parsed = parseUnitPrice(c.unitPrice);
    if (!parsed) continue;
    const bucket = parsedByDenomination.get(parsed.unit) ?? [];
    bucket.push({ product: c, value: parsed.value });
    parsedByDenomination.set(parsed.unit, bucket);
  }
  if (parsedByDenomination.size === 0) return null;

  // Compare within the largest same-denomination group -- the one most
  // products actually reported in, and so the most directly comparable set.
  let largest: { product: WooliesProductFull; value: number }[] | null = null;
  for (const bucket of parsedByDenomination.values()) {
    if (!largest || bucket.length > largest.length) largest = bucket;
  }
  if (!largest) return null;

  const cheapest = largest.reduce((best, c) => (c.value < best.value ? c : best));
  return {
    name: cheapest.product.name,
    pricePerUnit: cheapest.product.unitPrice ?? `$${cheapest.value.toFixed(2)}`,
  };
}
