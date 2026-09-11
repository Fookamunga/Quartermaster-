import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { syncPurchaseHistory } from "../purchaseHistorySync.js";
import { withDb } from "../storage.js";
import { toolJson } from "./shared.js";

export function registerSyncPurchaseHistory(server: McpServer): void {
  server.registerTool(
    "sync_purchase_history",
    {
      title: "Sync purchase history",
      description:
        "Fetch Woolworths' completed-order history (via woolies-mcp's " +
        "get_purchase_history) and reconcile any orders placed since the " +
        "last sync into this staples list's own purchase history -- feeds " +
        "the same restock-rate calculation as record_purchase and the " +
        "receipt/order-text ingest tools, just sourced directly from " +
        "Woolworths' own order records instead of a photo or pasted text. " +
        "This also runs automatically every week regardless of whether it's " +
        "ever called manually -- use this tool for an on-demand refresh, " +
        "e.g. right after placing a big order. Safe to call anytime: " +
        "already-synced orders are skipped by a timestamp watermark, and " +
        "individual lines are additionally deduped by order reference (the " +
        "same mechanism ingest_receipt/ingest_order_text use), so calling " +
        "this twice in a row processes nothing new the second time. If " +
        "Woolworths' session is dead, reports that explicitly rather than " +
        "silently reporting zero new orders.",
      inputSchema: {},
    },
    async () => {
      return withDb(async (db) => {
        const result = await syncPurchaseHistory(db);
        return toolJson(result);
      });
    },
  );
}
