import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  newRecipeId,
  resolveWeek,
  weekEndFor,
  withRecipes,
  type Recipe,
} from "../recipes.js";
import { toolError, toolJson } from "./shared.js";

export function registerAddRecipe(server: McpServer): void {
  server.registerTool(
    "add_recipe",
    {
      title: "Add recipe",
      description:
        "File a recipe against a week of the meal plan. Defaults to NEXT " +
        "week: recipes are collected during the current week for the week " +
        "ahead, so a recipe someone posts today is something they intend to " +
        "cook next week, not tonight. Pass week explicitly to override. A " +
        "week runs Sunday to Saturday, NZ time, and is identified by its " +
        "Sunday. Use this whenever someone shares a recipe -- a link, a " +
        "pasted method, or just a dish name -- rather than only when they " +
        "explicitly ask for it to be saved.",
      inputSchema: {
        title: z
          .string()
          .min(1)
          .describe("Dish name, e.g. \"Thai green curry\". The one required field."),
        body: z
          .string()
          .optional()
          .describe(
            "The recipe itself if there is one: method, ingredients, notes, " +
              "whatever was posted. Free-form, stored verbatim.",
          ),
        source_url: z.string().url().optional().describe("Link to the recipe, if it came from one"),
        week: z
          .string()
          .optional()
          .describe(
            "\"next\" (default), \"this\", \"last\", or any YYYY-MM-DD date " +
              "inside the target week -- it is snapped back to that week's Sunday.",
          ),
      },
    },
    async ({ title, body, source_url, week }) => {
      let weekStart: string;
      try {
        weekStart = resolveWeek(week, "next");
      } catch (err) {
        return toolError((err as Error).message);
      }

      return withRecipes((book) => {
        const existing = book.weeks[weekStart] ?? [];

        // Same-title guard, case-insensitive, scoped to the one week: the
        // realistic duplicate here is the same dish posted twice (a re-paste,
        // or two people sharing the same link), not two genuinely different
        // recipes that happen to share a name. Reported rather than errored
        // so a batch of recipes doesn't fail wholesale on one repeat.
        const duplicate = existing.find(
          (r) => r.title.trim().toLowerCase() === title.trim().toLowerCase(),
        );
        if (duplicate) {
          return toolJson({
            added: false,
            reason: "already_planned",
            week_start: weekStart,
            week_end: weekEndFor(weekStart),
            recipe: duplicate,
          });
        }

        const recipe: Recipe = {
          recipe_id: newRecipeId(),
          title: title.trim(),
          body: body?.trim() || null,
          source_url: source_url ?? null,
          added_at: new Date().toISOString(),
        };
        book.weeks[weekStart] = [...existing, recipe];

        return toolJson({
          added: true,
          week_start: weekStart,
          week_end: weekEndFor(weekStart),
          recipe,
          recipes_that_week: book.weeks[weekStart].length,
        });
      });
    },
  );
}
