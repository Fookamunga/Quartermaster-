import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { findBestItemMatch } from "../fuzzy.js";
import { withDb } from "../storage.js";
import { toolError, toolJson } from "./shared.js";

export function registerRemoveStaple(server: McpServer): void {
  server.registerTool(
    "remove_staple",
    {
      title: "Remove staple",
      description:
        "Delete a staple entirely. Its purchase_events are retained, not " +
        "deleted -- orphaned (no longer attached to any tracked item), in " +
        "case the staple is re-added later. This needs no special handling " +
        "elsewhere: every reader (list_staples, get_item, " +
        "suggest_alternatives, record_purchase, ...) looks up the item " +
        "first and only then filters purchase_events by its item_id, so an " +
        "orphaned event for a deleted item is simply never reached by any " +
        "of them. Re-adding a staple with the same name gets a new " +
        "item_id (via add_staple), so it does not recover the old history " +
        "automatically.",
      inputSchema: {
        name: z.string().min(1),
      },
    },
    async ({ name }) => {
      return withDb((db) => {
        const item = findBestItemMatch(db.items, name);
        if (!item) {
          return toolError(`No staple matching "${name}" was found.`);
        }

        db.items = db.items.filter((i) => i.item_id !== item.item_id);

        return toolJson({ removed: item.name });
      });
    },
  );
}
