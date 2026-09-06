import { findBestItemMatch } from "../fuzzy.js";
import { recomputeItemSummary } from "../replenishment.js";
import { newEventId } from "../storage.js";
import type { Database } from "../types.js";

export interface RecordedLine {
  line: string;
  item_name: string;
}

export interface RecordLinesResult {
  matched: RecordedLine[];
  already_recorded: RecordedLine[];
  unmatched: string[];
}

/**
 * Fuzzy-matches each line against the staples list and records a purchase
 * event per match, deduping at the individual line level rather than the
 * whole order: a line whose matched item already has a purchase_event under
 * the same order_reference is skipped (already_recorded), while any other
 * line under that same reference is still recorded normally. This is what
 * makes a multi-page paste of one order resolve correctly (only the new
 * page's lines get added) and a genuine full re-paste resolve correctly too
 * (every line lands in already_recorded, nothing duplicated) -- see
 * CLAUDE.md's "Order-reference dedup" section. Shared by ingest_receipt and
 * ingest_order_text so this dedup behavior is defined in exactly one place.
 *
 * The "already recorded" check is against the database as it stood before
 * this call, not against lines just recorded earlier in this same loop --
 * two genuinely different lines in one order that happen to fuzzy-match the
 * same staple (e.g. two different milk sizes) are both real purchases and
 * both get recorded.
 */
export function recordOrderLines(
  db: Database,
  lines: string[],
  purchaseDate: string,
  orderReference: string | null,
  rawRefFor: (line: string) => string | null,
): RecordLinesResult {
  const alreadyRecordedItemIds = new Set(
    orderReference
      ? db.purchase_events
          .filter((e) => e.order_reference === orderReference)
          .map((e) => e.item_id)
      : [],
  );

  const matched: RecordedLine[] = [];
  const already_recorded: RecordedLine[] = [];
  const unmatched: string[] = [];

  for (const line of lines) {
    const item = findBestItemMatch(db.items, line);
    if (!item) {
      unmatched.push(line);
      continue;
    }

    if (alreadyRecordedItemIds.has(item.item_id)) {
      already_recorded.push({ line, item_name: item.name });
      continue;
    }

    db.purchase_events.push({
      event_id: newEventId(),
      item_id: item.item_id,
      date: purchaseDate,
      source: "receipt_scan",
      raw_ref: rawRefFor(line),
      order_reference: orderReference,
      // The extracted line text itself, e.g. "Mainland Cheese Edam 500g" --
      // distinct from raw_ref, which is the shared order/receipt reference
      // (same for every line in the order, so it can't identify which
      // specific product this event was).
      product_name: line,
      sku: null,
      created_at: new Date().toISOString(),
    });

    const eventsForItem = db.purchase_events.filter((e) => e.item_id === item.item_id);
    recomputeItemSummary(item, eventsForItem);
    item.updated_at = new Date().toISOString();

    matched.push({ line, item_name: item.name });
  }

  return { matched, already_recorded, unmatched };
}
