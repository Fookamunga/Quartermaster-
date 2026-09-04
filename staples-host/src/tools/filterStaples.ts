import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { findBestItemMatch } from "../fuzzy.js";
import { readDb } from "../storage.js";
import { toolJson } from "./shared.js";

export function registerFilterStaples(server: McpServer): void {
  server.registerTool(
    "filter_staples",
    {
      title: "Filter staples",
      description:
        "Given a recipe's ingredient list, return which ones still need to " +
        "be bought. An ingredient counts as already-stocked only if it " +
        "fuzzy-matches a tracked item whose status is not_due; unmatched " +
        "ingredients (not tracked as a staple at all) are treated as " +
        "needed, since there's no data suggesting they're on hand.",
      inputSchema: {
        ingredients: z.array(z.string().min(1)).min(1),
      },
    },
    async ({ ingredients }) => {
      const db = await readDb();
      const needed: {
        ingredient: string;
        matched_item: string | null;
        reason: "not_tracked" | "due" | "overdue";
      }[] = [];
      const alreadyStocked: {
        ingredient: string;
        matched_item: string;
      }[] = [];

      for (const ingredient of ingredients) {
        const match = findBestItemMatch(db.items, ingredient);
        if (!match) {
          needed.push({
            ingredient,
            matched_item: null,
            reason: "not_tracked",
          });
        } else if (match.status === "not_due") {
          alreadyStocked.push({ ingredient, matched_item: match.name });
        } else {
          needed.push({
            ingredient,
            matched_item: match.name,
            reason: match.status,
          });
        }
      }

      return toolJson({ needed, already_stocked: alreadyStocked });
    },
  );
}
