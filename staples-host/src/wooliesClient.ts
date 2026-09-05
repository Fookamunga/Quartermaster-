import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WOOLIES_MCP_URL } from "./config.js";

// staples-host's one narrow, read-only exception to never calling woolies-mcp
// itself (see CLAUDE.md's Ownership boundaries) -- used only by
// suggest_alternatives to re-resolve a historical product_name to a live
// product via woolies-mcp's own search_products tool. No cart access, no
// auth token of its own: this is a plain MCP client call like any other
// caller's, using whatever WOOLIES_MCP_URL already grants.
//
// A fresh client + transport per call, not a held-open connection -- mirrors
// this server's own "stateless streamable-HTTP" design for its own /mcp
// route (see index.ts): staples-host is a single low-traffic household
// service, so per-call connection overhead is a non-issue and it avoids
// holding a long-lived connection to a service this project has always
// treated as external and sealed.

export interface WooliesProduct {
  sku: string;
  variantKey: string;
  name: string;
  price: number | null;
}

export class WooliesNotConfiguredError extends Error {
  constructor() {
    super("WOOLIES_MCP_URL is not set -- suggest_alternatives cannot resolve anything.");
    this.name = "WooliesNotConfiguredError";
  }
}

/**
 * Search woolies-mcp's catalogue and return the top result, or null if the
 * search comes back empty (e.g. a discontinued/delisted product). Throws
 * only on a genuine connection/protocol failure -- an empty result set is
 * a normal, expected outcome here, not an error.
 */
export async function searchTopProduct(query: string): Promise<WooliesProduct | null> {
  if (!WOOLIES_MCP_URL) throw new WooliesNotConfiguredError();

  const client = new Client({ name: "staples-host", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(WOOLIES_MCP_URL));
  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: "search_products",
      arguments: { query },
    });
    const block = Array.isArray(result.content) ? result.content[0] : undefined;
    if (!block || block.type !== "text") return null;
    const parsed = JSON.parse(block.text) as { products?: Array<Record<string, unknown>> };
    const top = parsed.products?.[0];
    if (!top || typeof top.sku !== "string" || typeof top.name !== "string") return null;
    return {
      sku: top.sku,
      variantKey: typeof top.variantKey === "string" ? top.variantKey : top.sku,
      name: top.name,
      price: typeof top.price === "number" ? top.price : null,
    };
  } finally {
    await client.close().catch(() => {});
  }
}
