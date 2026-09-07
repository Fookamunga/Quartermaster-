import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildShoppingList } from "../shoppingList.js";
import { readDb } from "../storage.js";
import { toolJson } from "./shared.js";

export function registerBuildShoppingList(server: McpServer): void {
  server.registerTool(
    "build_shopping_list",
    {
      title: "Build shopping list",
      description:
        "The tool for a multi-ingredient list (e.g. from a recipe) -- this " +
        "agent has no direct search tool of its own (see CLAUDE.md's " +
        "Architecture section), so this is the only way to resolve several " +
        "ingredients at once. Given a multi-ingredient list, resolve every " +
        "ingredient in one call instead of calling filter_staples and then " +
        "suggest_alternatives per item yourself. For each ingredient this " +
        "runs the same three-tier resolution the single-item disambiguation " +
        "flow uses (purchase history, then cart-narrowed search, then a " +
        "broad search) and returns pre-numbered, ready-to-render results.\n\n" +
        "Response shape: `items`, one entry per input ingredient, each either " +
        "`already_stocked: true` (with `matched_item`, the tracked staple it " +
        "matched -- render as 'Staple - not ordered by default', don't add " +
        "to cart unless explicitly asked) or `already_stocked: false` with:\n" +
        "- `tier`: 'history' (a `recommended: true` alternative exists -- mark " +
        "it ✅, same meaning as the single-item flow's top_pick), 'cart' or " +
        "'search' (no recommendation -- every alternative has equal weight), " +
        "or 'none' (nothing resolved at all -- say so plainly, don't invent " +
        "an option).\n" +
        "- `alternatives`: up to 3, each with its own `number` -- unique " +
        "across this ENTIRE response, not restarted per ingredient. Render " +
        "each exactly as numbered; never renumber or reorder them yourself.\n" +
        "- `all_alternatives`: the same list, untrimmed (up to 5) -- only " +
        "used for the follow-up described below, never rendered as part of " +
        "the initial reply.\n\n" +
        "No best-value figure here, unlike the single-item flow -- it was " +
        "the dominant per-ingredient cost and this tool is time-constrained " +
        "in a way that flow isn't (see below). If asked which option is " +
        "cheapest for a specific ingredient, call suggest_alternatives or " +
        "get_best_value for that one item instead of guessing.\n\n" +
        "How to interpret a reply: when the user replies with a list of " +
        "numbers (e.g. '1 4 6'), match each number against the numbers this " +
        "tool assigned in its most recent response in this conversation, and " +
        "apply that alternative as the selection for whichever ingredient it " +
        "belongs to. Never auto-select or otherwise proceed with ANY " +
        "ingredient that isn't explicitly covered by one of the reply's " +
        "numbers -- this applies uniformly across all three tiers, including " +
        "an ingredient whose `recommended: true` alternative exists: a " +
        "recommendation is always a suggestion, never an automatic " +
        "selection, and only takes effect if its own specific number is " +
        "chosen. For every ingredient not covered by the reply, don't guess " +
        "and don't drop it silently -- follow up by re-showing that " +
        "ingredient's `all_alternatives` (its full original list, not the " +
        "trimmed 3 from the first response) with fresh numbering scoped to " +
        "just that one ingredient, and ask explicitly whether it's needed at " +
        "all.\n\n" +
        "If a very long ingredient list can't all be resolved within this " +
        "call's own time budget, the response includes `partial: true` and " +
        "`not_attempted` (the ingredient names skipped, in the order given). " +
        "Say so plainly rather than pretending the list is complete -- render " +
        "the resolved `items` as normal, then note which ones weren't " +
        "checked yet and that they can be asked about in a follow-up call " +
        "with just those names.\n\n" +
        "Read-only: never touches the cart, never places an order.",
      inputSchema: {
        ingredients: z.array(z.string().min(1)).min(1).describe("Plain ingredient names, e.g. from a recipe"),
      },
    },
    async ({ ingredients }) => {
      const db = await readDb();
      const result = await buildShoppingList(db, ingredients);
      return toolJson(result);
    },
  );
}
