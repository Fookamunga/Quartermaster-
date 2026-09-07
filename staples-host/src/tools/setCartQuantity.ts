import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getProductFull, setCartQuantity, WooliesNotConfiguredError } from "../wooliesClient.js";
import { toolError, toolJson } from "./shared.js";

// woolies-mcp's own pricingUnit values, uppercase -- see the
// #woolworths-ordering workspace CLAUDE.md's now-superseded "Cart quantities
// are absolute, not deltas" note: a cart write needs 'EACH' or 'KG', derived
// from the product's own purchasingUnit field ('Each' | 'Kg'), a mechanic
// the agent used to have to know about because it called woolies-mcp
// directly. Resolving it here means the caller never needs to -- it just
// gives a sku and a quantity.
function derivePricingUnit(purchasingUnit: string | null): "EACH" | "KG" {
  return purchasingUnit?.toUpperCase() === "KG" ? "KG" : "EACH";
}

export function registerSetCartQuantity(server: McpServer): void {
  server.registerTool(
    "set_cart_quantity",
    {
      title: "Set cart quantity",
      description:
        "The only way to add to, change, or remove from the Woolworths " +
        "cart from an agent session -- there is no direct woolies-mcp " +
        "access here (see CLAUDE.md's Architecture section). Sets one " +
        "product's cart line to an exact quantity, not a delta -- e.g. " +
        "quantity 2 means 'have exactly 2 in the cart', not 'add 2 more'. " +
        "Quantity 0 removes the line entirely.\n\n" +
        "Given just a sku and a quantity, resolves the product's own " +
        "purchasing unit server-side (via woolies-mcp's get_product) and " +
        "applies it automatically -- the caller never needs to know or " +
        "supply 'EACH' vs 'KG' itself. Use a whole number for an " +
        "each-priced product; a decimal (e.g. 0.5) is only meaningful for " +
        "a product actually sold by weight, and is ignored (rounded/adjusted " +
        "by Woolworths' own site logic) otherwise -- see `adjusted` below.\n\n" +
        "Returns `{name, sku, requested_quantity, applied_quantity, " +
        "adjusted, line_in_cart, price}` -- `name`/`price` come from the " +
        "product lookup this tool already does internally to resolve the " +
        "purchasing unit, not from the cart response itself. The site may " +
        "silently adjust a requested quantity (e.g. loose produce rounding " +
        "to the nearest 0.5kg) -- when `adjusted` is true, report " +
        "`applied_quantity`, the amount that actually landed in the cart, " +
        "not what was requested. `line_in_cart` is false after a quantity-0 " +
        "removal (expected, not a failure) and true otherwise. Use get_cart " +
        "first if you don't already have the sku for what you want to " +
        "change -- this tool never searches or resolves a name.",
      inputSchema: {
        sku: z.string().min(1).describe("Woolworths product SKU to set the cart line for"),
        quantity: z.number().min(0).describe("Exact quantity to set -- 0 removes the line"),
      },
    },
    async ({ sku, quantity }) => {
      let product;
      try {
        product = await getProductFull(sku);
      } catch (err) {
        if (err instanceof WooliesNotConfiguredError) {
          return toolError(err.message);
        }
        return toolError(`Could not resolve sku ${sku}: ${(err as Error).message}`);
      }
      if (!product) return toolError(`Sku ${sku} did not resolve to a real product -- nothing was changed.`);

      const pricingUnit = derivePricingUnit(product.purchasingUnit);

      let result;
      try {
        result = await setCartQuantity(sku, quantity, pricingUnit);
      } catch (err) {
        return toolError(`Could not update the cart: ${(err as Error).message}`);
      }
      if (!result) return toolError(`Cart update for sku ${sku} did not return a usable result.`);

      return toolJson({
        name: product.name,
        sku: result.sku,
        requested_quantity: result.requestedQuantity,
        applied_quantity: result.appliedQuantity,
        adjusted: result.adjusted,
        line_in_cart: result.lineInCart,
        ...(product.price !== null ? { price: product.price } : {}),
      });
    },
  );
}
