import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { computeStatus } from "../replenishment.js";
import { readDb } from "../storage.js";
import { toolJson } from "./shared.js";

export function registerListStaples(server: McpServer): void {
  server.registerTool(
    "list_staples",
    {
      title: "List staples",
      description:
        "List every staple item with its current status (not_due/due/overdue), " +
        "last purchase date, and restock rate. Never say 'interval' in " +
        "user-facing text -- always 'restock rate'. replenishment_interval_days " +
        "means different things depending on interval_confidence: for 'manual' " +
        "it's a flat day-count, phrase as 'restock rate: every <N> days'; for " +
        "'learned' it's a days-per-unit rate (scaled by how much was bought " +
        "last time), phrase as 'restock rate: ~<N> days per unit'; for " +
        "'seeded' there's no rate at all, phrase as 'no restock rate set yet'. " +
        "Two rendering modes depending on what was asked for:\n" +
        "(a) 'show me my staples' (the default, full-detail view) -- one " +
        "combined line per item, exactly: '<name> — <last bought <date> " +
        "OR no purchase on record> — <restock rate phrase>'. For example:\n" +
        "Bread — last bought 2025-08-18 — restock rate: every 5 days\n" +
        "Oat milk — last bought 2025-09-01 — restock rate: ~7 days per unit\n" +
        "Fish sauce — no purchase on record — no restock rate set yet\n" +
        "(b) 'show my restock rate'/'show my staples update status' -- " +
        "simpler, just '<name> — <restock rate phrase>', no last-bought part.",
    },
    async () => {
      const db = await readDb();
      // Status is derived fresh here rather than trusting the stored
      // item.status -- that field is only a write-time cache, updated by
      // recomputeItemSummary() after record_purchase/ingest_* calls. Under
      // normal usage (purchase_events is append-only, no delete tool
      // exists) it can never drift, but re-deriving it on every read means
      // a caller here is never exposed to a stale value regardless of how
      // one might arise (a future bug, a migration, manual data surgery --
      // exactly what caused a real stale "overdue" with a null interval
      // during this project's own testing).
      const items = db.items
        .map((item) => {
          const eventsForItem = db.purchase_events
            .filter((e) => e.item_id === item.item_id)
            .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
          const lastPurchaseQuantity = eventsForItem[0]?.quantity ?? null;
          return {
            name: item.name,
            status: computeStatus(item, eventsForItem.length, lastPurchaseQuantity),
            last_purchased: item.last_purchased,
            replenishment_interval_days: item.replenishment_interval_days,
            interval_confidence: item.interval_confidence,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      return toolJson({ items });
    },
  );
}
