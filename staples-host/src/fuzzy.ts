import Fuse from "fuse.js";
import { FUZZY_MATCH_THRESHOLD } from "./config.js";
import type { Item } from "./types.js";

/**
 * Fuzzy-match a free-text name against the item list (handles receipt OCR
 * noise, plurals, abbreviations, etc.). Returns null if nothing scores
 * within FUZZY_MATCH_THRESHOLD.
 */
export function findBestItemMatch(
  items: Item[],
  query: string,
): Item | null {
  const exact = items.find(
    (i) => i.name.trim().toLowerCase() === query.trim().toLowerCase(),
  );
  if (exact) return exact;

  const fuse = new Fuse(items, {
    keys: ["name"],
    includeScore: true,
    threshold: FUZZY_MATCH_THRESHOLD,
  });
  const [best] = fuse.search(query);
  return best ? best.item : null;
}
