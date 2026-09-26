import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { findConflictingItem, normalizeAliases } from "../fuzzy.js";
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
        "exact name (case-insensitive) already exists, or if any alias " +
        "given is already taken by another staple.",
      inputSchema: {
        name: z.string().min(1),
        interval_days: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Restock rate in days, if already known"),
        aliases: z
          .array(z.string())
          .optional()
          .describe(
            "Other names this staple should be recognized by on a receipt: " +
              "brand names and retailer synonyms that share no words with the " +
              "staple name, e.g. [\"sorbent\", \"bath tissue\"] for \"toilet " +
              "paper\". Needed because abbreviated in-store receipt lines often " +
              "show only a brand, which no amount of fuzzy matching can connect " +
              "to a generic staple name. Entries under 3 characters are dropped.",
          ),
      },
    },
    async ({ name, interval_days, aliases }) => {
      return withDb((db) => {
        if (db.items.some((i) => sameName(i.name, name))) {
          return toolError(`A staple named "${name}" already exists.`);
        }

        const normalizedAliases = normalizeAliases(aliases ?? []);
        // Checked against names AND aliases of every other staple: a
        // duplicate on either side makes lookups for that string ambiguous.
        const conflict = findConflictingItem(db.items, [name, ...normalizedAliases], null);
        if (conflict) {
          return toolError(
            `"${conflict.value}" is already used by the staple "${conflict.item.name}".`,
          );
        }

        const now = new Date().toISOString();
        const item: Item = {
          item_id: newItemId(),
          name,
          aliases: normalizedAliases,
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
