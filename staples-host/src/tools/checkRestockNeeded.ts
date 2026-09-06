import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { itemsRunningOutSoon } from "../weeklyReportSentry.js";
import { readDb } from "../storage.js";
import { toolJson } from "./shared.js";

export function registerCheckRestockNeeded(server: McpServer): void {
  server.registerTool(
    "check_restock_needed",
    {
      title: "Check restock needed",
      description:
        "On-demand version of the weekly restock report: which staples are " +
        "due, overdue, or projected to run out within 7 days, right now. " +
        "Uses the exact same calculation as the scheduled Sunday Discord " +
        "report (effective restock rate minus days since last purchase, " +
        "<= 7 days), not a separate approximation -- so this always agrees " +
        "with what that report would say if it ran this instant. Returns " +
        "`items`, sorted most-urgent first, each with `days_until_due` " +
        "(<= 0 means already due/overdue -- e.g. -3 means overdue by 3 " +
        "days; a positive number means due in that many days) and " +
        "`restock_rate_days` (the effective rate this was projected from). " +
        "This is a direct answer to a direct question, not a scheduled " +
        "push -- phrase it that way (e.g. 'Bread is overdue by 3 days, and " +
        "Salt will need restocking in 4 days' or, when `items` is empty, " +
        "plainly 'Nothing needs restocking right now' or similar), not the " +
        "weekly report's '📅 Weekly restock check' framing, which only " +
        "exists because that path has no agent to phrase it. Group by the " +
        "sign of `days_until_due` (already due/overdue vs. running out " +
        "soon) the same way the weekly report does, for consistency, but " +
        "compose your own wording rather than echoing that report's exact " +
        "text.",
      inputSchema: {},
    },
    async () => {
      const db = await readDb();
      const items = itemsRunningOutSoon(db).map((i) => ({
        name: i.name,
        days_until_due: i.daysUntilDue,
        restock_rate_days: i.replenishmentIntervalDays,
      }));
      return toolJson({ items });
    },
  );
}
