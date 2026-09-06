import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { computeStatusFromAnchor } from "../replenishment.js";
import { newItemId, withDb } from "../storage.js";
import type { Item } from "../types.js";
import { toolError, toolJson } from "./shared.js";

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function registerAddStaple(server: McpServer): void {
  server.registerTool(
    "add_staple",
    {
      title: "Add staple",
      description:
        "Add a new staple to track. interval_days is optional -- if " +
        "omitted, the item starts with no restock rate at all (the same " +
        "'not enough data yet' state as a fresh Craft-synced item used to " +
        "start in), eligible to learn one automatically once enough real " +
        "purchase history exists. If given, the restock rate is marked " +
        "'manual' and is never silently overwritten by a learned value, " +
        "even once enough history exists to compute one -- see " +
        "update_staple to change it later. Fails if a staple with this " +
        "exact name (case-insensitive) already exists.",
      inputSchema: {
        name: z.string().min(1),
        interval_days: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Restock rate in days, if already known"),
      },
    },
    async ({ name, interval_days }) => {
      return withDb((db) => {
        if (db.items.some((i) => sameName(i.name, name))) {
          return toolError(`A staple named "${name}" already exists.`);
        }

        const now = new Date().toISOString();
        const item: Item = {
          item_id: newItemId(),
          name,
          sku: null,
          replenishment_interval_days: interval_days ?? null,
          interval_confidence: interval_days != null ? "manual" : "seeded",
          status: interval_days != null ? computeStatusFromAnchor(interval_days, null) : "not_due",
          last_purchased: null,
          last_purchased_source: null,
          created_at: now,
          updated_at: now,
        };
        db.items.push(item);

        return toolJson({ item });
      });
    },
  );
}
