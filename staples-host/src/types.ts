export type PurchaseSource = "receipt_scan" | "order_history_api";
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
  last_purchased_source: PurchaseSource | null;
  created_at: string; // ISO datetime
  updated_at: string; // ISO datetime
}

export interface PurchaseEvent {
  event_id: string;
  item_id: string;
  date: string; // ISO date (YYYY-MM-DD)
  source: PurchaseSource;
  raw_ref: string | null;
  created_at: string; // ISO datetime
}

export interface Database {
  items: Item[];
  purchase_events: PurchaseEvent[];
}
