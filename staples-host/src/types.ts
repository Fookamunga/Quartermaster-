export type PurchaseSource = "receipt_scan" | "order_history_api";
// last_purchased_source can also be "manual_seed" -- set directly by
// update_staple's optional last_purchased param, with no backing
// purchase_event. Kept distinct from PurchaseSource (which types actual
// purchase_events.source) since a manual seed is never a real event.
export type LastPurchasedSource = PurchaseSource | "manual_seed";
// "seeded": no interval at all yet (a brand-new item, or one add_staple
// created without an interval) -- eligible to become "learned" once enough
// purchase history exists. "learned": computed from real purchase history
// (median gap, >=3 events). "manual": explicitly set via add_staple's
// interval_days or update_staple -- never silently overwritten by a learned
// value, even once enough history exists to compute one; stays in force
// until explicitly changed. See CLAUDE.md's Replenishment logic.
export type IntervalConfidence = "seeded" | "learned" | "manual";
export type ItemStatus = "not_due" | "due" | "overdue";

export interface Item {
  item_id: string;
  name: string;
  sku: string | null;
  replenishment_interval_days: number | null;
  interval_confidence: IntervalConfidence;
  status: ItemStatus;
  last_purchased: string | null; // ISO date (YYYY-MM-DD)
  last_purchased_source: LastPurchasedSource | null;
  created_at: string; // ISO datetime
  updated_at: string; // ISO datetime
}

export interface PurchaseEvent {
  event_id: string;
  item_id: string;
  date: string; // ISO date (YYYY-MM-DD)
  source: PurchaseSource;
  raw_ref: string | null;
  // Order/invoice number (e.g. Woolworths NZ's "Order Confirmation/Invoice
  // Number CD47859895"), when the source exposes one. Primary cross-source
  // dedup key: null for sources with no invoice number (in-store receipts,
  // handwritten notes), which fall back to the ±2-day date+item proximity
  // check in the reconciliation pass instead. See CLAUDE.md.
  order_reference: string | null;
  // The specific product text as extracted from the source (e.g. "Mainland
  // Cheese Edam 500g"), distinct from item_id, which points at the generic
  // staple (e.g. "Cheese"). Null for events recorded before this field
  // existed, and for a manual record_purchase call that doesn't supply one.
  // See CLAUDE.md's Choosing a Product Among Multiple Matches / purchase
  // history section for how this gets used.
  product_name: string | null;
  // A real Woolworths product SKU, when the source structurally provides
  // one -- expected only from the future order_history_api source. Never
  // reliably present on a scanned receipt or pasted order text, so
  // receipt_scan events always leave this null rather than guessing.
  sku: string | null;
  // Quantity actually purchased/supplied. Every write path now sets a
  // concrete number (defaulting to 1 when the source doesn't determine one) --
  // null only ever appears on events recorded before this field existed.
  // recomputeItemSummary/medianIntervalDays treat a null the same as 1, so
  // pre-existing history degrades gracefully to the old flat-interval math
  // rather than needing a backfill. See CLAUDE.md's Replenishment logic.
  quantity: number | null;
  created_at: string; // ISO datetime
}

export interface Database {
  items: Item[];
  purchase_events: PurchaseEvent[];
  // NZ-local ISO date (YYYY-MM-DD) of the Sunday the weekly restock report
  // last actually posted for -- prevents double-posting within the same
  // Sunday-5pm-NZ hour (the sentry's tick interval can land more than once
  // inside that hour) and re-posting after a restart. Null until the first
  // report ever sends. See weeklyReportSentry.ts.
  lastWeeklyReportSentAt: string | null;
  // ISO datetime (UTC, exactly as woolies-mcp's get_purchase_history returns
  // it in `placedAt`) of the most recently processed order -- the
  // client-side incremental-fetch watermark. get_purchase_history has no
  // real server-side pagination (confirmed live: it always returns its full
  // available window), so this is what keeps a repeat sync cheap and
  // idempotent instead of re-processing every order every time. Null until
  // the first sync ever runs. See purchaseHistorySync.ts.
  lastPurchaseHistorySyncedAt: string | null;
  // NZ-local ISO date (YYYY-MM-DD) the *scheduled* weekly sync last actually
  // ran successfully -- distinct from lastPurchaseHistorySyncedAt (which
  // tracks real order data, not when the job ran): prevents the scheduled
  // sentry from re-running within the same Sunday-16:00-NZ hour or after a
  // restart, same dedup pattern as lastWeeklyReportSentAt. A manual
  // sync_purchase_history call never touches this field -- only the
  // scheduled sentry does. See purchaseHistorySyncSentry.ts.
  lastPurchaseHistoryScheduledSyncDate: string | null;
}
