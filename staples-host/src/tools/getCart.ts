import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getCart, WooliesNotConfiguredError } from "../wooliesClient.js";
import { toolError, toolJson } from "./shared.js";

export function registerGetCart(server: McpServer): void {
  server.registerTool(
    "get_cart",
    {
      title: "Get cart",
      description:
        "The only way to read the current Woolworths cart from an agent " +
        "session -- there is no direct woolies-mcp access here (see " +
        "CLAUDE.md's Architecture section). Use this for an already-in-cart " +
        "check before rendering suggest_alternatives/build_shopping_list " +
        "candidates, or when the user directly asks what's in their cart.\n\n" +
        "Returns `lines`, one entry per cart line: `{name, sku, quantity, " +
        "price, unit_price}`. `price` and `unit_price` are omitted (never " +
        "guessed) if the underlying line doesn't carry a parseable one. An " +
        "empty `lines` array means the cart is genuinely empty, not an " +
        "auth/connection failure -- this tool proves the session is live by " +
        "successfully returning at all. Read-only: never modifies the cart.",
      inputSchema: {},
    },
    async () => {
      let lines;
      try {
        lines = await getCart();
      } catch (err) {
        if (err instanceof WooliesNotConfiguredError) {
          return toolError(err.message);
        }
        return toolError(`Could not read cart: ${(err as Error).message}`);
      }
      return toolJson({
        lines: lines.map((l) => ({
          name: l.name,
          sku: l.sku,
          quantity: l.quantity,
          ...(l.price !== null ? { price: l.price } : {}),
          ...(l.unitPrice !== null ? { unit_price: l.unitPrice } : {}),
        })),
      });
    },
  );
}
