import { findBestItemMatch } from "./fuzzy.js";
import type { Item } from "./types.js";

export interface NeededIngredient {
  ingredient: string;
  matched_item: string | null;
  reason: "not_tracked" | "due" | "overdue";
}

export interface StockedIngredient {
  ingredient: string;
  matched_item: string;
}

export interface ClassifiedIngredients {
  needed: NeededIngredient[];
  alreadyStocked: StockedIngredient[];
}

/**
 * Splits a raw ingredient list into "already stocked" (fuzzy-matches a
 * tracked item whose status is not_due) vs "needed" (either not tracked at
 * all, or tracked but due/overdue). Shared by filter_staples and
 * build_shopping_list so the two tools can never disagree about which
 * ingredients count as already on hand.
 */
export function classifyIngredients(items: Item[], ingredients: string[]): ClassifiedIngredients {
  const needed: NeededIngredient[] = [];
  const alreadyStocked: StockedIngredient[] = [];

  for (const ingredient of ingredients) {
    const match = findBestItemMatch(items, ingredient);
    if (!match) {
      needed.push({ ingredient, matched_item: null, reason: "not_tracked" });
    } else if (match.status === "not_due") {
      alreadyStocked.push({ ingredient, matched_item: match.name });
    } else {
      needed.push({ ingredient, matched_item: match.name, reason: match.status });
    }
  }

  return { needed, alreadyStocked };
}
