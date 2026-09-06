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
        "last purchase date, and restock rate. Present replenishment_interval_days " +
        "to the user as 'restock rate' (e.g. 'restock rate: every 5 days', or " +
        "'no restock rate set yet' when null) -- never say 'interval' in " +
        "user-facing text.",
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
          const eventCount = db.purchase_events.filter((e) => e.item_id === item.item_id).length;
          return {
            name: item.name,
            status: computeStatus(item, eventCount),
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
