import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  readRecipes,
  recipesForWeek,
  resolveWeek,
  thisWeekStart,
  weekEndFor,
} from "../recipes.js";
import { toolError, toolJson } from "./shared.js";

export function registerGetRecipes(server: McpServer): void {
  server.registerTool(
    "get_recipes",
    {
      title: "Get recipes",
      description:
        "The meal plan for a week. Defaults to THIS week -- \"what am I " +
        "eating this week\", \"what's for dinner\", \"what are this week's " +
        "recipes\" all mean the current Sunday-to-Saturday week, NZ time. " +
        "Pass week to look elsewhere; \"next\" is where newly-added recipes " +
        "land, so use it to check what has been planned so far.",
      inputSchema: {
        week: z
          .string()
          .optional()
          .describe(
            "\"this\" (default), \"next\", \"last\", or any YYYY-MM-DD date " +
              "inside the target week -- it is snapped back to that week's Sunday.",
          ),
      },
    },
    async ({ week }) => {
      let weekStart: string;
      try {
        weekStart = resolveWeek(week, "this");
      } catch (err) {
        return toolError((err as Error).message);
      }

      const book = await readRecipes();
      const recipes = recipesForWeek(book, weekStart);
      const current = thisWeekStart();

      return toolJson({
        week_start: weekStart,
        week_end: weekEndFor(weekStart),
        // Lets the caller phrase the answer correctly without re-deriving the
        // date maths -- "this week" vs "next week" vs a specific past week
        // read very differently back to a person.
        is_current_week: weekStart === current,
        count: recipes.length,
        recipes,
      });
    },
  );
}
