import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WOOLIES_MCP_URL } from "./config.js";

// staples-host's own server-side client for woolies-mcp -- the one path in
// this codebase allowed to call it directly (see CLAUDE.md's Ownership
// boundaries and Architecture section: no agent session, cold or warm, ever
// gets woolies-mcp registered as an MCP server of its own; every product
// search, cart read, and cart write it needs goes through a staples-host
// tool that calls this file server-side instead). Originally read-only
// (product search, for suggest_alternatives' history-resolution), extended
// to include cart reads and writes (getCart, setCartQuantity) once
// woolies-mcp was fully deregistered from agent sessions and the agent lost
// direct cart access entirely -- see setCartQuantity.ts/getCart.ts. No auth
// token of its own regardless: every call here is a plain MCP client call
// like any other caller's, using whatever WOOLIES_MCP_URL already grants.
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
  // 'Each' | 'Kg' (woolies-mcp's own casing) -- setCartQuantity.ts uses this
  // to derive the pricingUnit a cart write needs ('EACH' | 'KG'), so the
  // caller of that tool never needs to know this mechanic exists at all.
  purchasingUnit: string | null;
}

export interface CartLine {
  sku: string;
  variantKey: string;
  name: string;
  quantity: number;
  price: number | null;
  unitPrice: string | null;
}

export class WooliesNotConfiguredError extends Error {
  constructor() {
    super("WOOLIES_MCP_URL is not set -- suggest_alternatives cannot resolve anything.");
    this.name = "WooliesNotConfiguredError";
  }
}

/**
 * Shared connect/call/close boilerplate for every woolies-mcp tool call this
 * file makes -- a fresh client + transport per call, not held open (see this
 * file's header comment). Returns the first text-content block's parsed JSON,
 * or null if the response carries no usable text block or the tool itself
 * reported an error.
 *
 * `isError` results are treated as null, not thrown -- confirmed live,
 * get_product reports an unresolvable sku via `isError: true` with a plain
 * text message ("...returned no product for 99999999...", not JSON), so
 * blindly JSON.parse-ing whatever's in `content[0]` regardless of `isError`
 * crashed on that plain text instead of degrading to "nothing found," the
 * same normal outcome an empty search_products result already gets. A
 * genuine connection/protocol failure (the client can't reach woolies-mcp at
 * all) still throws as before -- this only changes how a response the
 * server successfully sent back, but flagged as an error, gets handled.
 */
async function callWooliesTool(
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  if (!WOOLIES_MCP_URL) throw new WooliesNotConfiguredError();

  const client = new Client({ name: "staples-host", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(WOOLIES_MCP_URL));
  try {
    await client.connect(transport);
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) return null;
    const block = Array.isArray(result.content) ? result.content[0] : undefined;
    if (!block || block.type !== "text") return null;
    return JSON.parse(block.text) as Record<string, unknown>;
  } finally {
    await client.close().catch(() => {});
  }
}

async function callSearchProducts(
  query: string,
  page: number,
): Promise<{ products: Array<Record<string, unknown>>; complete: boolean }> {
  const parsed = await callWooliesTool("search_products", { query, page });
  const products = Array.isArray(parsed?.products) ? (parsed.products as Array<Record<string, unknown>>) : [];
  return { products, complete: parsed?.complete !== false };
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
    purchasingUnit: typeof raw.purchasingUnit === "string" ? raw.purchasingUnit : null,
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
 * Fetch one product's full details directly by SKU via woolies-mcp's
 * get_product tool -- for get_best_value.ts, resolving a Tier 2/3 anchor
 * (a cart line or a search result, both of which the agent already has a
 * sku for) to the full shape findBestValue needs (brand, unitPrice). A cart
 * line from get_cart carries unitPrice but not brand, so this is the only
 * way to get both for a cart-item anchor without the agent doing its own
 * extra woolies-mcp call. Returns null if the sku doesn't resolve; throws
 * only on a genuine connection/protocol failure, same as searchTopProductFull.
 */
export async function getProductFull(sku: string): Promise<WooliesProductFull | null> {
  const parsed = await callWooliesTool("get_product", { sku });
  return parsed ? toFull(parsed) : null;
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

/**
 * The first page of a plain, unnarrowed search_products call -- used by
 * build_shopping_list's Tier 2 (a cart line's own narrowed query) and Tier 3
 * (the bare generic term) for their numbered-list display, both of which
 * only ever need the site's own first-page relevance order, not full
 * pagination (that's searchAllPages/searchVariety's job, used only for
 * best-value's own broader comparison). Throws only on a genuine
 * connection/protocol failure; an empty result set is a normal outcome.
 */
export async function searchFirstPage(query: string): Promise<WooliesProductFull[]> {
  const { products } = await callSearchProducts(query, 1);
  const full: WooliesProductFull[] = [];
  for (const raw of products) {
    const p = toFull(raw);
    if (p) full.push(p);
  }
  return full;
}

/**
 * List the current cart's lines -- used internally by build_shopping_list's
 * and suggest_alternatives' Tier 2 to find a plausible already-in-cart line
 * for an ingredient with no purchase history, and exposed directly as
 * staples-host's own get_cart tool (getCart.ts) so an agent session -- which
 * has no woolies-mcp access of its own -- can still read cart contents.
 * Throws only on a genuine connection/protocol failure; an empty cart is a
 * normal result (get_cart proves the session first, so it's never a
 * silently-expired-session artifact -- see the real tool's own description).
 */
export async function getCart(): Promise<CartLine[]> {
  const parsed = await callWooliesTool("get_cart", {});
  const rawLines = Array.isArray(parsed?.lines) ? (parsed.lines as Array<Record<string, unknown>>) : [];
  const lines: CartLine[] = [];
  for (const raw of rawLines) {
    if (typeof raw.sku !== "string" || typeof raw.name !== "string") continue;
    lines.push({
      sku: raw.sku,
      variantKey: typeof raw.variantKey === "string" ? raw.variantKey : raw.sku,
      name: raw.name,
      quantity: typeof raw.quantity === "number" ? raw.quantity : 1,
      price: typeof raw.price === "number" ? raw.price : null,
      unitPrice: typeof raw.unitPrice === "string" ? raw.unitPrice : null,
    });
  }
  return lines;
}

export interface SetCartQuantityResult {
  sku: string;
  requestedQuantity: number;
  appliedQuantity: number;
  adjusted: boolean;
  // Whether the line is actually in the cart after this call -- true after
  // a normal add/update, false after a quantity-0 removal (not a failure
  // signal in that case, just the expected post-removal state).
  lineInCart: boolean;
}

/**
 * Set one cart line to an exact quantity via woolies-mcp's own
 * set_cart_quantity tool -- 0 removes the line. Takes pricingUnit
 * ('EACH' | 'KG') as a plain argument rather than deriving it here, since
 * the caller (setCartQuantity.ts) already resolved it from the product's
 * own purchasingUnit field via getProductFull -- this function stays a thin
 * call+parse wrapper, matching every other function in this file.
 *
 * Confirmed live (direct diagnostic call against the real API) that the
 * real response does NOT carry a product `name` or `price` at all -- only
 * `sku`, `variantKey`, `requestedQuantity`/`requestedPricingUnit`,
 * `appliedQuantity`/`appliedPricingUnit`, `adjusted`, `lineInCart`,
 * `cartTotalQuantity`, `cartLineCount`, and checkout-readiness fields
 * (`checkoutBlocked`/`blockers`) this function doesn't need. An earlier
 * version of this function assumed a `name` field would be present and
 * treated its absence as failure -- confirmed live this made the function
 * return null on every call, including successful ones (the cart write
 * genuinely happened; this function just reported it as failed). The
 * caller (setCartQuantity.ts) already has the product's name/price from
 * its own prior `getProductFull` call, so this function was never the
 * right place to source them from anyway.
 *
 * Success is judged by a resolvable `sku` in the response, not by any of
 * the optional fields above -- defensively parsed with the same tolerant
 * typeof-guards as this file's other parsers, since this is still someone
 * else's API response, and falls back to the requested quantity if
 * `appliedQuantity` is missing (`adjusted: false` in that case -- the
 * safest default when the real outcome can't be confirmed from the
 * response shape). Throws only on a genuine connection/protocol failure;
 * returns null only if the response carries no usable sku at all (an
 * actual failure to apply, not a normal outcome to expect often).
 */
export async function setCartQuantity(
  sku: string,
  quantity: number,
  pricingUnit: "EACH" | "KG",
): Promise<SetCartQuantityResult | null> {
  const parsed = await callWooliesTool("set_cart_quantity", { sku, quantity, pricingUnit });
  if (!parsed) return null;
  const resolvedSku = typeof parsed.sku === "string" ? parsed.sku : null;
  if (!resolvedSku) return null;
  return {
    sku: resolvedSku,
    requestedQuantity: typeof parsed.requestedQuantity === "number" ? parsed.requestedQuantity : quantity,
    appliedQuantity: typeof parsed.appliedQuantity === "number" ? parsed.appliedQuantity : quantity,
    adjusted: parsed.adjusted === true,
    lineInCart: parsed.lineInCart === true,
  };
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

// "Good enough to stop trimming" threshold for searchVariety below -- not a
// promise of 5 usable results (SUSPECT_WORDS/denomination-grouping filtering
// happens downstream in bestValue.ts, and the numbered-list caller takes
// only as many as it needs), just enough that the query is plausibly a real
// shared category rather than one brand's own product line.
const MIN_VARIETY_RESULTS = 5;

/**
 * Same-variety search with query broadening -- shared by findBestValue
 * (bestValue.ts) and Tier 1's live-search backfill (alternatives.ts), both
 * of which start from deriveVarietyQuery's brand+size-stripped residual.
 * That residual isn't always a real shared category: a product whose brand
 * has its own sub-line/product name baked in (e.g. Otis "Oat Milk The
 * Everyday One", vs. a generic "Cheese Edam") leaves residual wording no
 * other brand would use, so the plain query only ever finds that one
 * product back. Confirmed live: "Oat Milk The Everyday One" and each single
 * trim down to "Oat Milk The" all return only Otis's own 1-3 products;
 * "Oat Milk" (trimmed to the MIN_QUERY_WORDS floor) returns 30, with
 * genuine cross-brand alternatives (So Good, Boring, Vitasoy, ...) right at
 * the top.
 *
 * This was a real, silent gap in findBestValue before this function existed
 * -- it was quietly reporting a product like Otis's oat milk as its own
 * "best value" whenever its variety query stayed this narrow, missing
 * genuinely cheaper cross-brand options a shopper would want to know about.
 * Not caught earlier because the original test case ("Mainland Cheese Edam
 * 500g" -> "Cheese Edam") happened to have no brand sub-line wording to
 * strip.
 *
 * Retries with the query trimmed one word from the end at a time if the
 * current attempt's first page returns fewer than MIN_VARIETY_RESULTS, down
 * to the MIN_QUERY_WORDS floor -- same no-curated-word-list reasoning as
 * searchTopProductFull (the real catalogue is the ground truth, checked
 * directly, rather than guessing which words are brand-line noise). No
 * separate attempt cap unlike searchTopProductFull's: that one is called up
 * to 10 times per suggest_alternatives invocation (once per historical
 * event), so its retry depth is capped to bound worst-case latency: this
 * runs at most once or twice per invocation, so the latency budget is
 * comfortably wider.
 *
 * Returns the broadened query alongside the LAST probe's own first-page
 * results -- shared by searchVariety (which re-fetches with full pagination
 * for a genuine coverage guarantee) and searchVarietyFirstPageOnly (which
 * reuses this first page directly, no re-fetch) below, so the two never
 * duplicate the actual broadening logic.
 */
async function broadenVarietyQuery(
  query: string,
): Promise<{ broadenedQuery: string; firstPage: WooliesProductFull[] }> {
  const words = query.trim().split(/\s+/).filter(Boolean);
  let broadenedQuery = query;
  let firstPage: WooliesProductFull[] = [];

  for (let wordCount = words.length; wordCount >= Math.min(MIN_QUERY_WORDS, words.length); wordCount--) {
    const attemptQuery = words.slice(0, wordCount).join(" ");
    const { products } = await callSearchProducts(attemptQuery, 1);
    broadenedQuery = attemptQuery;
    firstPage = products.map(toFull).filter((p): p is WooliesProductFull => p != null);
    if (products.length >= MIN_VARIETY_RESULTS) break;
  }

  return { broadenedQuery, firstPage };
}

/**
 * Once a broad-enough query is found (cheaply, via a single-page check),
 * re-fetches it with full pagination so findBestValue's cheapest-across-
 * everything claim keeps its existing coverage guarantee. Use this for a
 * single, confident best-value answer (the single-item disambiguation
 * flow) -- see searchVarietyFirstPageOnly for the cheaper alternative used
 * when this cost would otherwise be paid once per ingredient in a
 * multi-item shopping list.
 */
export async function searchVariety(query: string): Promise<WooliesProductFull[]> {
  const { broadenedQuery } = await broadenVarietyQuery(query);
  return searchAllPages(broadenedQuery);
}

/**
 * Cheaper alternative to searchVariety: returns the broadening loop's own
 * last first-page fetch directly, with NO further re-fetch/pagination --
 * confirmed live this is the dominant cost searchVariety pays (up to ~27s
 * for one ingredient, most of a real build_shopping_list call's per-
 * ingredient time), acceptable to pay once for a single confident answer
 * but not once per ingredient across a whole shopping list. Trades away
 * full-catalogue coverage for a "cheapest among what the broadening probe
 * already saw" figure -- a weaker, but still genuine, best-effort estimate,
 * consistent with best-value already being documented as best-effort rather
 * than an authoritative cheapest-available claim (see CLAUDE.md). Used only
 * by build_shopping_list's per-ingredient best-value -- the single-item
 * flow keeps searchVariety's full guarantee unchanged.
 */
export async function searchVarietyFirstPageOnly(query: string): Promise<WooliesProductFull[]> {
  const { firstPage } = await broadenVarietyQuery(query);
  return firstPage;
}

export interface PurchaseHistoryOrderItem {
  sku: string;
  name: string;
  quantity: number;
}

export interface PurchaseHistoryOrder {
  reference: string;
  placedAt: string; // ISO datetime, UTC (exactly as woolies-mcp returns it)
  status: string;
  items: PurchaseHistoryOrderItem[];
}

/**
 * Fetch Woolworths' completed-order history via woolies-mcp's own
 * get_purchase_history tool -- the sole data source for
 * purchaseHistorySync.ts's reconciliation into staples-host's own
 * purchase_events (see CLAUDE.md's order-history sync section). Confirmed
 * live against the real account: no real server-side pagination exists --
 * the tool always returns its full available window (46 real orders,
 * spanning 2021-2026, at the time this was verified) and its own `coverage`
 * field says so explicitly ("the site ignores the page index"). So this
 * always fetches everything; incremental behavior is entirely a client-side
 * filter against a stored watermark in purchaseHistorySync.ts, not a
 * paginated request here.
 *
 * Deliberately not woolies-mcp's separate get_order_history tool -- confirmed
 * live (a direct diagnostic call) that it currently throws a schema-
 * validation error on this real account
 * (`fulfilments.0.fulfilmentLocation: expected object, received null`),
 * while get_purchase_history returns clean, complete data covering
 * everything this sync needs (reference, placedAt, per-line sku/name/
 * quantity, with real non-null quantities throughout).
 *
 * Throws on a genuine connection/protocol failure OR an unparseable/errored
 * tool response -- never silently returns an empty order list, since that
 * would be indistinguishable from a genuinely up-to-date sync (see
 * CLAUDE.md's auth-failure note: a failed fetch must surface as "sync didn't
 * run," not "nothing new").
 */
export async function getPurchaseHistory(): Promise<PurchaseHistoryOrder[]> {
  const parsed = await callWooliesTool("get_purchase_history", { filter: "PAST" });
  if (!parsed) {
    throw new Error("get_purchase_history returned no usable response (isError or unparseable)");
  }

  const rawOrders = Array.isArray(parsed.orders) ? (parsed.orders as Array<Record<string, unknown>>) : [];
  const orders: PurchaseHistoryOrder[] = [];
  for (const raw of rawOrders) {
    if (typeof raw.reference !== "string" || typeof raw.placedAt !== "string") continue;

    const rawItems = Array.isArray(raw.items) ? (raw.items as Array<Record<string, unknown>>) : [];
    const items: PurchaseHistoryOrderItem[] = [];
    for (const item of rawItems) {
      if (typeof item.sku !== "string" || typeof item.name !== "string") continue;
      items.push({
        sku: item.sku,
        name: item.name,
        quantity: typeof item.quantity === "number" ? item.quantity : 1,
      });
    }

    orders.push({
      reference: raw.reference,
      placedAt: raw.placedAt,
      status: typeof raw.status === "string" ? raw.status : "COMPLETED",
      items,
    });
  }
  return orders;
}

export interface WooliesAuthStatus {
  accountToolsUsable: boolean;
  cookieExpiresAt: string | null;
  hint: string | null;
}

/**
 * Woolworths session health, via woolies-mcp's own auth_status tool --
 * confirmed live shape: `{ accountToolsUsable: boolean, cookieExpiresAt?:
 * string, hint: string }`. Used by purchaseHistorySync.ts to distinguish
 * "genuinely nothing new" from "the session is dead and get_purchase_history
 * would silently look like zero orders" -- an auth failure during the sync
 * must be surfaced the same way discordbot-host's own auth-failure sentry
 * already treats it, never as "no orders in this period" (which would
 * silently advance the sync watermark past real, un-synced purchases). A
 * failed auth_status call itself is treated as "not usable" -- fail closed,
 * rather than letting the sync guess.
 */
export async function getAuthStatus(): Promise<WooliesAuthStatus> {
  const parsed = await callWooliesTool("auth_status", {});
  if (!parsed) {
    return {
      accountToolsUsable: false,
      cookieExpiresAt: null,
      hint: "auth_status call itself returned no usable response",
    };
  }
  return {
    accountToolsUsable: parsed.accountToolsUsable === true,
    cookieExpiresAt: typeof parsed.cookieExpiresAt === "string" ? parsed.cookieExpiresAt : null,
    hint: typeof parsed.hint === "string" ? parsed.hint : null,
  };
}
