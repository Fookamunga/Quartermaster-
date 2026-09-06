import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { findBestItemMatch } from "../fuzzy.js";
import { computeStatus } from "../replenishment.js";
import { readDb } from "../storage.js";
import { toolError, toolJson } from "./shared.js";

export function registerGetItem(server: McpServer): void {
  server.registerTool(
    "get_item",
    {
      title: "Get item",
      description:
        "Look up a single staple by name (fuzzy-matched) and return its full " +
        "detail, including its recent purchase-event history. Present " +
        "replenishment_interval_days to the user as 'restock rate' -- never " +
        "say 'interval' in user-facing text. Its meaning depends on " +
        "interval_confidence: 'manual' is a flat day-count ('restock rate: " +
        "every <N> days'); 'learned' is a days-per-unit rate scaled by the " +
        "most recent purchase_events entry's quantity ('restock rate: ~<N> " +
        "days per unit'); 'seeded' means no rate is set yet.",
      inputSchema: {
        name: z.string().min(1).describe("Item name, e.g. 'oat milk'"),
      },
    },
    async ({ name }) => {
      const db = await readDb();
      const item = findBestItemMatch(db.items, name);
      if (!item) {
        return toolError(`No staple matching "${name}" was found.`);
      }
      const events = db.purchase_events
        .filter((e) => e.item_id === item.item_id)
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
      // Status derived fresh, not trusted from the stored item.status --
      // see listStaples.ts for why (a write-time cache that can only ever
      // drift via manual data manipulation, but re-deriving it on every
      // read closes that risk entirely rather than relying on every write
      // path getting it right forever).
      const lastPurchaseQuantity = events[0]?.quantity ?? null;
      return toolJson({
        item: { ...item, status: computeStatus(item, events.length, lastPurchaseQuantity) },
        purchase_events: events,
      });
    },
  );
}
