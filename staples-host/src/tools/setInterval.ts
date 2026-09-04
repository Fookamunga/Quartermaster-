import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { findBestItemMatch } from "../fuzzy.js";
import { computeStatus } from "../replenishment.js";
import { withDb } from "../storage.js";
import { toolError, toolJson } from "./shared.js";

export function registerSetInterval(server: McpServer): void {
  server.registerTool(
    "set_interval",
    {
      title: "Set replenishment interval",
      description:
        "Manually override an item's replenishment interval (in days). " +
        "Marks the interval as 'seeded' confidence — it will be overwritten " +
        "by the learned median once 3+ purchase events exist.",
      inputSchema: {
        item_name: z.string().min(1),
        days: z.number().int().positive(),
      },
    },
    async ({ item_name, days }) => {
      return withDb((db) => {
        const item = findBestItemMatch(db.items, item_name);
        if (!item) {
          return toolError(`No staple matching "${item_name}" was found.`);
        }

        item.replenishment_interval_days = days;
        item.interval_confidence = "seeded";
        const eventCount = db.purchase_events.filter(
          (e) => e.item_id === item.item_id,
        ).length;
        item.status = computeStatus(item, eventCount);
        item.updated_at = new Date().toISOString();

        return toolJson({ item });
      });
    },
  );
}
