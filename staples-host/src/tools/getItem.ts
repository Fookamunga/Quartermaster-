import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { findBestItemMatch } from "../fuzzy.js";
import { readDb } from "../storage.js";
import { toolError, toolJson } from "./shared.js";

export function registerGetItem(server: McpServer): void {
  server.registerTool(
    "get_item",
    {
      title: "Get item",
      description:
        "Look up a single staple by name (fuzzy-matched) and return its full " +
        "detail, including its recent purchase-event history.",
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
      return toolJson({ item, purchase_events: events });
    },
  );
}
