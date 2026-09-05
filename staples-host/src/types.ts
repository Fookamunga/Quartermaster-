export type PurchaseSource = "receipt_scan" | "order_history_api";
// last_purchased_source can also be "manual_seed" -- set directly by
// set_interval's optional last_purchased param, with no backing
// purchase_event. Kept distinct from PurchaseSource (which types actual
// purchase_events.source) since a manual seed is never a real event.
export type LastPurchasedSource = PurchaseSource | "manual_seed";
export type IntervalConfidence = "seeded" | "learned";
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
  created_at: string; // ISO datetime
}

export interface Database {
  items: Item[];
  purchase_events: PurchaseEvent[];
}
