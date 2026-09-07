import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { findBestValue } from "../bestValue.js";
import { getProductFull, WooliesNotConfiguredError } from "../wooliesClient.js";
import { toolError, toolJson } from "./shared.js";

export function registerGetBestValue(server: McpServer): void {
  server.registerTool(
    "get_best_value",
    {
      title: "Get best value",
      description:
        "Given a specific product's SKU, find the cheapest same-variety " +
        "option across any brand (not just this product's own brand) -- " +
        "the same best-value computation suggest_alternatives runs " +
        "automatically for its Tier-1 top_pick, exposed standalone so Tier " +
        "2 and Tier 3 of the 'Choosing a Product Among Multiple Matches' " +
        "flow (see the #woolworths-ordering workspace CLAUDE.md) can " +
        "compute it too, anchored on whichever product they're comparing " +
        "against -- the already-in-cart item for Tier 2, the broad " +
        "search's own top result for Tier 3. Returns {name, sku, " +
        "pricePerUnit} or an empty object if nothing computable (the sku doesn't " +
        "resolve, it has no parseable unit price, the variety search finds " +
        "nothing, or nothing survives the exclusion heuristic) -- never a " +
        "guess. Same best-effort caveat as Tier 1's version: a best-effort " +
        "suggestion from a variety-wide search, not an authoritative " +
        "cheapest-available claim.",
      inputSchema: {
        sku: z.string().min(1).describe("Woolworths product SKU to anchor the comparison on"),
      },
    },
    async ({ sku }) => {
      let product;
      try {
        product = await getProductFull(sku);
      } catch (err) {
        if (err instanceof WooliesNotConfiguredError) {
          return toolError(err.message);
        }
        return toolError(`Could not resolve sku ${sku}: ${(err as Error).message}`);
      }
      if (!product) return toolJson({});

      const bestValue = await findBestValue(product);
      return toolJson(bestValue ?? {});
    },
  );
}
