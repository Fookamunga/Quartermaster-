import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { findBestItemMatch } from "../fuzzy.js";
import { recomputeItemSummary } from "../replenishment.js";
import { newEventId, withDb } from "../storage.js";
import { isoDate, toolError, toolJson } from "./shared.js";

export function registerRecordPurchase(server: McpServer): void {
  server.registerTool(
    "record_purchase",
    {
      title: "Record purchase",
      description:
        "Fuzzy-match item_name against the staples list, append a purchase " +
        "event, and update the item's last-purchased summary and " +
        "replenishment status. Fails if no matching item exists — items are " +
        "added via add_staple, not created here.",
      inputSchema: {
        item_name: z.string().min(1),
        date: isoDate.describe("Purchase date, YYYY-MM-DD"),
        source: z.enum(["receipt_scan", "order_history_api"]),
        raw_ref: z
          .string()
          .optional()
          .describe(
            "Free-text reference back to the source, e.g. a receipt line or order ID",
          ),
      },
    },
    async ({ item_name, date, source, raw_ref }) => {
      return withDb((db) => {
        const item = findBestItemMatch(db.items, item_name);
        if (!item) {
          return toolError(`No staple matching "${item_name}" was found.`);
        }

        const event = {
          event_id: newEventId(),
          item_id: item.item_id,
          date,
          source,
          raw_ref: raw_ref ?? null,
          // Manual single-item entry has no order to dedup against, and no
          // extracted product text or structural SKU to attach either.
          order_reference: null,
          product_name: null,
          sku: null,
          created_at: new Date().toISOString(),
        };
        db.purchase_events.push(event);

        const eventsForItem = db.purchase_events.filter(
          (e) => e.item_id === item.item_id,
        );
        recomputeItemSummary(item, eventsForItem);
        item.updated_at = new Date().toISOString();

        return toolJson({ event, item });
      });
    },
  );
}
