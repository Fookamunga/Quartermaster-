import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CRAFT_STAPLES_DOC_ID } from "../config.js";
import { CraftNotConfiguredError, extractItemNames, fetchCraftDocument } from "../craft.js";
import { newItemId, withDb } from "../storage.js";
import type { Item } from "../types.js";
import { toolError, toolJson } from "./shared.js";

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function registerSyncFromCraft(server: McpServer): void {
  server.registerTool(
    "sync_from_craft",
    {
      title: "Sync from Craft",
      description:
        "Pull the Staples list from Craft and add any item names not already " +
        "tracked. Matching is exact (case-insensitive) against existing item " +
        "names, not fuzzy — Craft is treated as the source of truth for what " +
        "items exist. This never removes or modifies existing items, so " +
        "purchase history is always preserved.",
    },
    async () => {
      if (!CRAFT_STAPLES_DOC_ID) {
        return toolError(
          "CRAFT_STAPLES_DOC_ID is not set. Add it to .env (see .env.example).",
        );
      }

      let names: string[];
      try {
        const doc = await fetchCraftDocument(CRAFT_STAPLES_DOC_ID);
        names = extractItemNames(doc);
      } catch (err) {
        if (err instanceof CraftNotConfiguredError) {
          return toolError(err.message);
        }
        return toolError(`Failed to sync from Craft: ${(err as Error).message}`);
      }

      return withDb((db) => {
        const added: string[] = [];
        const alreadyPresent: string[] = [];
        const now = new Date().toISOString();

        for (const name of names) {
          const exists = db.items.some((i) => sameName(i.name, name));
          if (exists) {
            alreadyPresent.push(name);
            continue;
          }
          const newItem: Item = {
            item_id: newItemId(),
            name,
            sku: null,
            replenishment_interval_days: null,
            interval_confidence: "seeded",
            status: "not_due",
            last_purchased: null,
            last_purchased_source: null,
            created_at: now,
            updated_at: now,
          };
          db.items.push(newItem);
          added.push(name);
        }

        return toolJson({
          added,
          already_present: alreadyPresent,
          total_in_craft: names.length,
        });
      });
    },
  );
}
