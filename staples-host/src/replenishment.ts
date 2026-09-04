import { OVERDUE_MULTIPLIER } from "./config.js";
import type { Item, ItemStatus, PurchaseEvent } from "./types.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysBetween(earlier: string, later: string): number {
  return Math.round((Date.parse(later) - Date.parse(earlier)) / MS_PER_DAY);
}

/**
 * Median gap (in days) between consecutive purchases, sorted oldest to
 * newest. Median rather than mean so one early/late outlier purchase
 * doesn't skew the whole estimate.
 */
export function medianIntervalDays(sortedDates: string[]): number | null {
  if (sortedDates.length < 3) return null;
  const gaps: number[] = [];
  for (let i = 1; i < sortedDates.length; i++) {
    gaps.push(daysBetween(sortedDates[i - 1], sortedDates[i]));
  }
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  const median =
    gaps.length % 2 === 0 ? (gaps[mid - 1] + gaps[mid]) / 2 : gaps[mid];
  return Math.round(median);
}

/**
 * Status is only ever evaluated once an item has at least 2 purchase
 * events — below that there's no purchase history to anchor a due date
 * against, so it always reads not_due. Items with no interval (not enough
 * data yet, or never set) never surface as due either.
 */
export function computeStatus(
  item: Pick<Item, "replenishment_interval_days" | "last_purchased">,
  eventCountForItem: number,
): ItemStatus {
  if (eventCountForItem < 2) return "not_due";
  if (item.replenishment_interval_days == null) return "not_due";
  if (!item.last_purchased) return "not_due";

  const daysSince = daysBetween(item.last_purchased, todayIso());
  if (daysSince >= item.replenishment_interval_days * OVERDUE_MULTIPLIER) {
    return "overdue";
  }
  if (daysSince >= item.replenishment_interval_days) {
    return "due";
  }
  return "not_due";
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Recompute an item's denormalized purchase summary + learned interval from
 * its full purchase-event history. Called after every record_purchase.
 */
export function recomputeItemSummary(
  item: Item,
  eventsForItem: PurchaseEvent[],
): void {
  if (eventsForItem.length === 0) {
    item.last_purchased = null;
    item.last_purchased_source = null;
    item.status = "not_due";
    return;
  }

  const sorted = [...eventsForItem].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
  );
  const latest = sorted[sorted.length - 1];
  item.last_purchased = latest.date;
  item.last_purchased_source = latest.source;

  if (sorted.length >= 3) {
    const learned = medianIntervalDays(sorted.map((e) => e.date));
    if (learned != null) {
      item.replenishment_interval_days = learned;
      item.interval_confidence = "learned";
    }
  }

  item.status = computeStatus(item, sorted.length);
}
