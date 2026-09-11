import { nzDateFromIso } from "./nzTime.js";
import { recordOrderLines } from "./tools/orderLineRecording.js";
import type { Database } from "./types.js";
import { getAuthStatus, getPurchaseHistory } from "./wooliesClient.js";

export interface PurchaseHistorySyncResult {
  ok: boolean;
  authFailure: boolean;
  ordersSeen: number;
  ordersProcessed: number;
  ordersSkippedAlreadySynced: number;
  matched: number;
  alreadyRecorded: number;
  unmatched: string[];
  error: string | null;
}

/**
 * Domain-logic reconciliation of Woolworths' order history into staples-host's
 * own purchase_events -- pure staples-host business logic, deliberately with
 * no awareness of Discord, discordbot-host, or any particular front end (see
 * CLAUDE.md's standing architecture rule: Discord is a disposable front end,
 * never something core logic lives inside or depends on). Called both by the
 * on-demand sync_purchase_history MCP tool and by
 * purchaseHistorySyncSentry.ts's own weekly schedule -- neither of those
 * callers is Discord-specific either.
 *
 * get_purchase_history has no real server-side pagination (confirmed live:
 * it always returns its full available window and says so via its own
 * `coverage` field). "Incremental" here is therefore a client-side filter
 * against `db.lastPurchaseHistorySyncedAt` (the placedAt of the most
 * recently processed order) rather than a paginated fetch -- every call
 * fetches everything, but only orders newer than the watermark are actually
 * reconciled. Belt-and-braces alongside that watermark: each order is still
 * run through recordOrderLines()'s own per-line, order-reference-keyed dedup
 * (the same mechanism ingest_receipt/ingest_order_text use), so even a
 * watermark reset or a re-processed order can't double-record a line.
 *
 * Never advances the watermark on an auth failure or a failed fetch -- an
 * auth failure must surface as "the sync didn't run," never silently look
 * like "nothing new to sync," which would corrupt the restock-rate data by
 * quietly skipping real un-synced purchases (see CLAUDE.md).
 */
export async function syncPurchaseHistory(db: Database): Promise<PurchaseHistorySyncResult> {
  const auth = await getAuthStatus();
  if (!auth.accountToolsUsable) {
    return {
      ok: false,
      authFailure: true,
      ordersSeen: 0,
      ordersProcessed: 0,
      ordersSkippedAlreadySynced: 0,
      matched: 0,
      alreadyRecorded: 0,
      unmatched: [],
      error: auth.hint ?? "Woolworths session is not usable right now.",
    };
  }

  let orders;
  try {
    orders = await getPurchaseHistory();
  } catch (err) {
    return {
      ok: false,
      authFailure: false,
      ordersSeen: 0,
      ordersProcessed: 0,
      ordersSkippedAlreadySynced: 0,
      matched: 0,
      alreadyRecorded: 0,
      unmatched: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const watermark = db.lastPurchaseHistorySyncedAt;
  const sorted = [...orders].sort((a, b) => (a.placedAt < b.placedAt ? -1 : a.placedAt > b.placedAt ? 1 : 0));
  // Strictly greater-than: the order that IS the current watermark was
  // already fully processed by the run that set it, so it must not be
  // reprocessed (that's what makes a same-data rerun a true no-op).
  const toProcess = watermark ? sorted.filter((o) => o.placedAt > watermark) : sorted;

  let matched = 0;
  let alreadyRecorded = 0;
  const unmatched: string[] = [];

  // Oldest-first: keeps the watermark meaningful (advances monotonically
  // through what was actually attempted) even if this loop were interrupted
  // partway -- though in practice recordOrderLines never throws.
  for (const order of toProcess) {
    const result = recordOrderLines(
      db,
      order.items.map((item) => ({ name: item.name, quantity: item.quantity, sku: item.sku })),
      nzDateFromIso(order.placedAt),
      order.reference,
      () => order.reference,
      "order_history_api",
    );
    matched += result.matched.length;
    alreadyRecorded += result.already_recorded.length;
    unmatched.push(...result.unmatched);
  }

  if (sorted.length > 0) {
    db.lastPurchaseHistorySyncedAt = sorted[sorted.length - 1].placedAt;
  }

  return {
    ok: true,
    authFailure: false,
    ordersSeen: orders.length,
    ordersProcessed: toProcess.length,
    ordersSkippedAlreadySynced: orders.length - toProcess.length,
    matched,
    alreadyRecorded,
    unmatched,
    error: null,
  };
}
