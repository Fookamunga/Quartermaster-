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

// Richer shape needed for the best-value comparison specifically (brand, to
// derive the variety query; unitPrice, to compare $/unit) -- Tier-1 ranking
// via searchTopProduct doesn't need either, so it stays on the narrower
// WooliesProduct shape rather than carrying fields it never uses.
export interface WooliesProductFull {
  sku: string;
  variantKey: string;
  name: string;
  brand: string | null;
  price: number | null;
  unitPrice: string | null;
}

export class WooliesNotConfiguredError extends Error {
  constructor() {
    super("WOOLIES_MCP_URL is not set -- suggest_alternatives cannot resolve anything.");
    this.name = "WooliesNotConfiguredError";
  }
}

async function callSearchProducts(
  query: string,
  page: number,
): Promise<{ products: Array<Record<string, unknown>>; complete: boolean }> {
  if (!WOOLIES_MCP_URL) throw new WooliesNotConfiguredError();

  const client = new Client({ name: "staples-host", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(WOOLIES_MCP_URL));
  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: "search_products",
      arguments: { query, page },
    });
    const block = Array.isArray(result.content) ? result.content[0] : undefined;
    if (!block || block.type !== "text") return { products: [], complete: true };
    const parsed = JSON.parse(block.text) as {
      products?: Array<Record<string, unknown>>;
      complete?: boolean;
    };
    return { products: parsed.products ?? [], complete: parsed.complete !== false };
  } finally {
    await client.close().catch(() => {});
  }
}

function toFull(raw: Record<string, unknown>): WooliesProductFull | null {
  if (typeof raw.sku !== "string" || typeof raw.name !== "string") return null;
  return {
    sku: raw.sku,
    variantKey: typeof raw.variantKey === "string" ? raw.variantKey : raw.sku,
    name: raw.name,
    brand: typeof raw.brand === "string" ? raw.brand : null,
    price: typeof raw.price === "number" ? raw.price : null,
    unitPrice: typeof raw.unitPrice === "string" ? raw.unitPrice : null,
  };
}

/**
 * Search woolies-mcp's catalogue and return the top result, or null if the
 * search comes back empty (e.g. a discontinued/delisted product). Throws
 * only on a genuine connection/protocol failure -- an empty result set is
 * a normal, expected outcome here, not an error.
 */
export async function searchTopProduct(query: string): Promise<WooliesProduct | null> {
  const top = await searchTopProductFull(query);
  if (!top) return null;
  return { sku: top.sku, variantKey: top.variantKey, name: top.name, price: top.price };
}

/**
 * Same as searchTopProduct, but returns the full shape (brand, unitPrice
 * included) -- used by best-value, which needs both to derive the variety
 * query and compare $/unit; Tier-1 ranking never needs either, so it stays
 * on the narrower searchTopProduct.
 */
export async function searchTopProductFull(query: string): Promise<WooliesProductFull | null> {
  const { products } = await callSearchProducts(query, 1);
  return toFull(products[0] ?? {});
}

// Safety cap on pages followed, independent of the real-world 1-2 pages a
// variety-level query needed when this was tested live -- protects against
// an unexpectedly broad query (or a `complete` flag that never turns true)
// turning best-value's one-request feature into an unbounded fetch loop.
const MAX_PAGES = 5;

/**
 * Search woolies-mcp's catalogue and return every result, following
 * pagination until `complete: true` or MAX_PAGES, whichever comes first --
 * used only by best-value's variety-wide comparison, never by Tier-1
 * ranking (which only ever needs the single top result per historical
 * name). Throws only on a genuine connection/protocol failure.
 */
export async function searchAllPages(query: string): Promise<WooliesProductFull[]> {
  const all: WooliesProductFull[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { products, complete } = await callSearchProducts(query, page);
    for (const raw of products) {
      const full = toFull(raw);
      if (full) all.push(full);
    }
    if (complete) break;
  }
  return all;
}
