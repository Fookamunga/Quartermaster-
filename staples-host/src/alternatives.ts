import type { PurchaseEvent } from "./types.js";
import { searchTopProduct, type WooliesProduct } from "./wooliesClient.js";

// See CLAUDE.md's suggest_alternatives entry and the #woolworths-ordering
// workspace CLAUDE.md's "Choosing a Product Among Multiple Matches" for the
// full three-tier design this is Tier 1 of.
const HISTORY_WINDOW = 10;
const MAX_ALTERNATIVES = 5;

export interface RankedAlternative {
  name: string;
  sku: string;
  price: number | null;
}

interface Candidate {
  product: WooliesProduct;
  frequency: number;
  mostRecentDate: string;
}

/**
 * Resolves and ranks alternatives from a caller-supplied, already-sorted
 * (most-recent-first), already-product_name-filtered event list. Resolves
 * sequentially, not in parallel -- this is a single low-traffic household
 * service calling a shared external dependency; there's no need to open up
 * to 10 concurrent connections to woolies-mcp for one request.
 */
export async function rankAlternatives(events: PurchaseEvent[]): Promise<RankedAlternative[]> {
  const window = events.slice(0, HISTORY_WINDOW);
  const candidates = new Map<string, Candidate>();

  for (const event of window) {
    let resolved: WooliesProduct | null;
    try {
      resolved = await searchTopProduct(event.product_name as string);
    } catch {
      // A genuine connection/protocol failure resolving this one historical
      // name -- treated the same as "no longer in the catalogue" (skip this
      // candidate, keep going), not a failure of the whole tier. See
      // CLAUDE.md: only an empty final list means "nothing resolved".
      resolved = null;
    }
    if (!resolved) continue;

    const key = resolved.variantKey;
    const existing = candidates.get(key);
    if (existing) {
      existing.frequency += 1;
      if (event.date > existing.mostRecentDate) existing.mostRecentDate = event.date;
    } else {
      candidates.set(key, { product: resolved, frequency: 1, mostRecentDate: event.date });
    }
  }

  return [...candidates.values()]
    .sort((a, b) => {
      if (b.frequency !== a.frequency) return b.frequency - a.frequency;
      // Tiebreaker only: more recent first.
      return a.mostRecentDate < b.mostRecentDate ? 1 : a.mostRecentDate > b.mostRecentDate ? -1 : 0;
    })
    .slice(0, MAX_ALTERNATIVES)
    .map((c) => ({ name: c.product.name, sku: c.product.sku, price: c.product.price }));
}
