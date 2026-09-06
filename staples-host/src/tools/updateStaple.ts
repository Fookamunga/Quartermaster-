import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { findBestItemMatch } from "../fuzzy.js";
import { computeStatusFromAnchor } from "../replenishment.js";
import { withDb } from "../storage.js";
import { toolError, toolJson } from "./shared.js";

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function registerUpdateStaple(server: McpServer): void {
  server.registerTool(
    "update_staple",
    {
      title: "Update staple",
      description:
        "Rename a staple and/or change its restock rate. " +
        "Setting interval_days marks the restock rate 'manual' -- it will " +
        "never be silently overwritten by a learned value computed from " +
        "purchase history, even once enough history exists to compute " +
        "one; it stays in force until this tool changes it again. This is " +
        "the sole way to manually override a restock rate (replaces the " +
        "former set_interval tool).",
      inputSchema: {
        name: z.string().min(1).describe("Current name of the staple to update"),
        new_name: z.string().min(1).optional(),
        interval_days: z.number().int().positive().optional().describe("New restock rate in days"),
      },
    },
    async ({ name, new_name, interval_days }) => {
      return withDb((db) => {
        const item = findBestItemMatch(db.items, name);
        if (!item) {
          return toolError(`No staple matching "${name}" was found.`);
        }

        if (new_name) {
          const collision = db.items.some(
            (i) => i.item_id !== item.item_id && sameName(i.name, new_name),
          );
          if (collision) {
            return toolError(`A staple named "${new_name}" already exists.`);
          }
          item.name = new_name;
        }

        if (interval_days != null) {
          item.replenishment_interval_days = interval_days;
          item.interval_confidence = "manual";
          item.status = computeStatusFromAnchor(item.replenishment_interval_days, item.last_purchased);
        }

        item.updated_at = new Date().toISOString();

        return toolJson({ item });
      });
    },
  );
}
