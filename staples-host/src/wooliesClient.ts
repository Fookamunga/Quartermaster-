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

// Never retry down to a single word -- too generic to trust as a specific
// product lookup (the whole point of this retry is finding the SAME
// product, not a plausible-looking different one).
const MIN_QUERY_WORDS = 2;

// Bounds worst-case latency, not match quality: alternatives.ts's
// rankAlternatives() resolves up to 10 historical events through this
// function *sequentially* (a deliberate existing choice -- no concurrent
// connections to a shared external dependency), and a name that never
// resolves at all is exactly the case that would otherwise cost the MOST
// retries. Uncapped, that risks turning one suggest_alternatives call into
// enough sequential HTTP round-trips to blow past the warm session's 40s
// per-tool-call timeout -- trading a clean "nothing found" for a hard
// timeout, a worse outcome. 2 extra attempts comfortably covers the real
// case this was built for (one trailing noise word) with room to spare,
// while keeping the pathological "genuinely unresolvable" case bounded.
const MAX_TRIM_ATTEMPTS = 2;

/**
 * Same as searchTopProduct, but returns the full shape (brand, unitPrice
 * included) -- used by best-value, which needs both to derive the variety
 * query and compare $/unit; Tier-1 ranking never needs either, so it stays
 * on the narrower searchTopProduct.
 *
 * Retries with the query trimmed one word at a time from the end if the
 * full phrase comes back empty. Needed because the only real caller of this
 * against free text -- rankAlternatives(), resolving a historical
 * purchase_event's product_name -- is receipt/order-derived text, which can
 * carry packaging/descriptor words that never appear in Woolworths' own
 * catalogue name at all. Confirmed live: the real stored product_name "Otis
 * oat milk the everyday one 1l carton" returns nothing (search_products ANDs
 * every query word, and the real catalogue name has no "carton" in it
 * anywhere), while the same phrase minus "carton" returns exactly the right
 * product.
 *
 * Deliberately not a curated list of packaging words to strip -- that was
 * the right call for the *forward* ingest-matching problem (see fuzzy.ts's
 * COMPOUND_MODIFIER_WORDS), because that was a genuine semantic ambiguity
 * with no ground truth to check a guess against. This is different: whether
 * a word belongs in the query is a factual question the real catalogue can
 * answer directly, one call away -- trimming and re-checking against it is
 * more general and self-correcting than guessing in advance which words are
 * "packaging noise" (a list that would need endless maintenance as new
 * brands invent new descriptor words).
 *
 * Trims from the end specifically, since pack/quantity/packaging wording is
 * the part of a receipt-derived name most likely to diverge from the
 * catalogue's own phrasing (the same "brand + core product name first,
 * descriptors after" shape confirmed during the ingest-matching work).
 * Stops at the FIRST non-empty result -- the least trimming that works, to
 * minimize the risk of over-trimming into a wrong, more generic product --
 * and only ever returns the top hit at whichever level succeeds, same as
 * the untrimmed case always did. A name that's genuinely no longer in the
 * catalogue still correctly returns null once every attempt is exhausted;
 * this doesn't turn "not found" into a guess, it just gives a noisy real
 * name more real chances to resolve first.
 */
export async function searchTopProductFull(query: string): Promise<WooliesProductFull | null> {
  const words = query.trim().split(/\s+/).filter(Boolean);
  const attempts = Math.min(MAX_TRIM_ATTEMPTS + 1, words.length - MIN_QUERY_WORDS + 1, words.length);

  for (let i = 0; i < Math.max(attempts, 1); i++) {
    const wordCount = words.length - i;
    const attemptQuery = words.slice(0, wordCount).join(" ");
    const { products } = await callSearchProducts(attemptQuery, 1);
    const top = toFull(products[0] ?? {});
    if (top) return top;
  }
  return null;
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
