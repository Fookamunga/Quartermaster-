import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { findBestItemMatch, findConflictingItem, normalizeAliases } from "../fuzzy.js";
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
        "former set_interval tool). add_aliases/remove_aliases edit the " +
        "alternative names this staple is recognized by on receipts; both " +
        "are additive/subtractive rather than replacing the whole list, so " +
        "a caller that does not know the current aliases cannot wipe them.",
      inputSchema: {
        name: z.string().min(1).describe("Current name of the staple to update"),
        new_name: z.string().min(1).optional(),
        interval_days: z.number().int().positive().optional().describe("New restock rate in days"),
        add_aliases: z
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
        remove_aliases: z
          .array(z.string())
          .optional()
          .describe("Aliases to stop recognizing, matched case-insensitively"),
      },
    },
    async ({ name, new_name, interval_days, add_aliases, remove_aliases }) => {
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

        if (add_aliases?.length) {
          const additions = normalizeAliases(add_aliases);
          const conflict = findConflictingItem(db.items, additions, item.item_id);
          if (conflict) {
            return toolError(
              `"${conflict.value}" is already used by the staple "${conflict.item.name}".`,
            );
          }
          // Re-normalized over the merged list so an addition that only
          // differs in case from an existing alias collapses rather than
          // being stored twice.
          item.aliases = normalizeAliases([...item.aliases, ...additions]);
        }

        if (remove_aliases?.length) {
          const drop = new Set(remove_aliases.map((a) => a.trim().toLowerCase()));
          item.aliases = item.aliases.filter((a) => !drop.has(a.trim().toLowerCase()));
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
