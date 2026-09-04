import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { findBestItemMatch } from "../fuzzy.js";
import { computeStatusFromAnchor } from "../replenishment.js";
import { withDb } from "../storage.js";
import { isoDate, toolError, toolJson } from "./shared.js";

export function registerSetInterval(server: McpServer): void {
  server.registerTool(
    "set_interval",
    {
      title: "Set replenishment interval",
      description:
        "Manually override an item's replenishment interval (in days). " +
        "Marks the interval as 'seeded' confidence — it will be overwritten " +
        "by the learned median once 3+ purchase events exist. Optionally " +
        "takes an anchor last_purchased date: if given, status/due " +
        "calculations run exactly like a learned item (no purchase-count " +
        "gate). If omitted and the item has no existing purchase history, " +
        "it comes back due immediately rather than sitting in 'not enough " +
        "data' — a seeded interval with nothing to anchor it should surface.",
      inputSchema: {
        item_name: z.string().min(1),
        days: z.number().int().positive(),
        last_purchased: isoDate
          .optional()
          .describe(
            "Anchor date, YYYY-MM-DD. Sets last_purchased_source to " +
              "'manual_seed'; overwritten by real purchase data once any exists.",
          ),
      },
    },
    async ({ item_name, days, last_purchased }) => {
      return withDb((db) => {
        const item = findBestItemMatch(db.items, item_name);
        if (!item) {
          return toolError(`No staple matching "${item_name}" was found.`);
        }

        item.replenishment_interval_days = days;
        item.interval_confidence = "seeded";
        if (last_purchased) {
          item.last_purchased = last_purchased;
          item.last_purchased_source = "manual_seed";
        }
        item.status = computeStatusFromAnchor(
          item.replenishment_interval_days,
          item.last_purchased,
        );
        item.updated_at = new Date().toISOString();

        return toolJson({ item });
      });
    },
  );
}
