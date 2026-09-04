import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readDb } from "../storage.js";
import { toolJson } from "./shared.js";

export function registerListStaples(server: McpServer): void {
  server.registerTool(
    "list_staples",
    {
      title: "List staples",
      description:
        "List every staple item with its current status (not_due/due/overdue), " +
        "last purchase date, and replenishment interval.",
    },
    async () => {
      const db = await readDb();
      const items = db.items
        .map((item) => ({
          name: item.name,
          status: item.status,
          last_purchased: item.last_purchased,
          replenishment_interval_days: item.replenishment_interval_days,
          interval_confidence: item.interval_confidence,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return toolJson({ items });
    },
  );
}
