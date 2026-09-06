import { OVERDUE_MULTIPLIER } from "./config.js";
import type { Item, ItemStatus, PurchaseEvent } from "./types.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysBetween(earlier: string, later: string): number {
  return Math.round((Date.parse(later) - Date.parse(earlier)) / MS_PER_DAY);
}

export function daysSince(dateIso: string): number {
  return daysBetween(dateIso, todayIso());
}

/**
 * Median per-unit rate (days/unit) between consecutive purchases, sorted
 * oldest to newest -- e.g. 5 units lasting 35 days contributes 7 days/unit.
 * A null quantity (an event recorded before quantity was captured) is
 * treated as 1, so old history degrades to the pre-quantity flat-interval
 * math instead of skewing the rate. Median rather than mean so one
 * early/late outlier purchase doesn't skew the whole estimate. Rounded to
 * one decimal place -- coarser than that loses real precision once this
 * rate gets multiplied by a large quantity (e.g. a bulk buy of 10), but
 * more precision than that would just be noise from day-granularity data.
 */
export function medianIntervalDays(
  sortedEvents: { date: string; quantity: number | null }[],
): number | null {
  if (sortedEvents.length < 3) return null;
  const gaps: number[] = [];
  for (let i = 1; i < sortedEvents.length; i++) {
    const days = daysBetween(sortedEvents[i - 1].date, sortedEvents[i].date);
    const quantity = sortedEvents[i - 1].quantity ?? 1;
    gaps.push(days / quantity);
  }
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  const median =
    gaps.length % 2 === 0 ? (gaps[mid - 1] + gaps[mid]) / 2 : gaps[mid];
  return Math.round(median * 10) / 10;
}

/**
 * The interval to actually anchor status math against: for "manual", the
 * flat day-count as-is (a human's explicit choice is deliberately
 * quantity-blind -- see CLAUDE.md). For "learned", replenishment_interval_days
 * is a days-per-unit rate, so it's scaled by the most recent purchase's
 * quantity (null/undetermined treated as 1). For "seeded" (no rate at all),
 * null either way.
 */
export function effectiveIntervalDays(
  item: Pick<Item, "replenishment_interval_days" | "interval_confidence">,
  lastPurchaseQuantity: number | null,
): number | null {
  if (item.replenishment_interval_days == null) return null;
  if (item.interval_confidence === "learned") {
    return item.replenishment_interval_days * (lastPurchaseQuantity ?? 1);
  }
  return item.replenishment_interval_days;
}

/**
 * Pure due/overdue math from an interval + anchor date, no event count
 * involved. No interval -> never due. Interval set but no anchor date at
 * all -> due immediately (a manually-seeded item with nothing to anchor it
 * should surface, not sit silent as "not enough data" — see CLAUDE.md's
 * add_staple/update_staple exception). Otherwise the normal threshold math.
 */
export function computeStatusFromAnchor(
  intervalDays: number | null,
  lastPurchased: string | null,
): ItemStatus {
  if (intervalDays == null) return "not_due";
  if (!lastPurchased) return "due";

  const days = daysSince(lastPurchased);
  if (days >= intervalDays * OVERDUE_MULTIPLIER) return "overdue";
  if (days >= intervalDays) return "due";
  return "not_due";
}

/**
 * Status is only ever evaluated once an item has at least 2 purchase
 * events — below that there's no purchase history to anchor a due date
 * against, so it always reads not_due. This gate applies only to the
 * organic, purchase-event-driven path (recomputeItemSummary below);
 * add_staple/update_staple's manually-seeded anchor bypasses it entirely
 * and calls computeStatusFromAnchor directly — see CLAUDE.md.
 */
export function computeStatus(
  item: Pick<Item, "replenishment_interval_days" | "interval_confidence" | "last_purchased">,
  eventCountForItem: number,
  lastPurchaseQuantity: number | null,
): ItemStatus {
  if (eventCountForItem < 2) return "not_due";
  return computeStatusFromAnchor(
    effectiveIntervalDays(item, lastPurchaseQuantity),
    item.last_purchased,
  );
}

// Household is in NZ (Woolworths NZ, NZ Tailscale-hosted infra) but the
// container almost certainly isn't -- confirmed live on the NAS: both
// staples-host and discordbot-host run in UTC (no TZ set, the standard
// minimal-base-image default), while NZ is UTC+12/+13. `new
// Date().toISOString()` is always UTC regardless of any TZ env var, so it
// silently returns yesterday's date for roughly the first half of every NZ
// calendar day. Hardcoded to Pacific/Auckland rather than reading TZ from
// the environment -- this way it's correct regardless of container/OS
// config, and can't silently regress if a future redeploy forgets to set
// TZ. Confirmed working inside the actual node:24-slim base image (full
// ICU, no separate tzdata package needed).
const NZ_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Pacific/Auckland",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function todayIso(): string {
  return NZ_DATE_FORMATTER.format(new Date());
}

/**
 * Recompute an item's denormalized purchase summary + learned interval from
 * its full purchase-event history. Called after every record_purchase.
 *
 * Never overwrites a manually-set interval (interval_confidence: "manual",
 * set by add_staple/update_staple): a human's explicit choice stays in force
 * until they explicitly change it, even once enough purchase history exists
 * to compute a learned value -- see CLAUDE.md's Replenishment logic. This is
 * a separate concept from "seeded", which now means only "no interval at
 * all yet" (a brand-new item with nothing set).
 */
export function recomputeItemSummary(
  item: Item,
  eventsForItem: PurchaseEvent[],
): void {
  if (eventsForItem.length === 0) {
    item.last_purchased = null;
    item.last_purchased_source = null;
    if (item.interval_confidence === "manual") {
      // A manual interval has no dependency on purchase history at all --
      // losing every event (e.g. an admin data correction) shouldn't undo
      // an explicit human choice, only recompute status against it fresh.
      item.status = computeStatusFromAnchor(item.replenishment_interval_days, null);
    } else {
      // Genuinely no purchase history means no basis for a learned interval
      // either -- unreachable in normal operation (events are append-only,
      // so a previously-non-zero count never drops back to zero on its own)
      // until an admin-driven correction removes a bad event and calls this
      // again; without this, a stale replenishment_interval_days/
      // interval_confidence from before the removal would survive,
      // misrepresenting an item with zero real purchases as having a
      // learned pattern.
      item.replenishment_interval_days = null;
      item.interval_confidence = "seeded";
      item.status = "not_due";
    }
    return;
  }

  const sorted = [...eventsForItem].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
  );
  const latest = sorted[sorted.length - 1];
  item.last_purchased = latest.date;
  item.last_purchased_source = latest.source;

  if (sorted.length >= 3 && item.interval_confidence !== "manual") {
    const learned = medianIntervalDays(
      sorted.map((e) => ({ date: e.date, quantity: e.quantity })),
    );
    if (learned != null) {
      item.replenishment_interval_days = learned;
      item.interval_confidence = "learned";
    }
  }

  item.status = computeStatus(item, sorted.length, latest.quantity);
}
