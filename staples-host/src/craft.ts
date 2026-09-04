import { CRAFT_API_TOKEN, CRAFT_CONNECT_URL } from "./config.js";

// Craft's Connect API (https://connect.craft.do/api-docs) exposes a share
// link scoped to specific documents. The link path scopes which docs are
// visible; requests also need `Authorization: Bearer <CRAFT_API_TOKEN>`
// (a personal API key from Craft, separate from the link itself).

interface CraftBlock {
  id: string;
  type: string;
  markdown?: string;
  listStyle?: string;
  content?: CraftBlock[];
}

export class CraftNotConfiguredError extends Error {
  constructor() {
    super(
      "CRAFT_CONNECT_URL and/or CRAFT_API_TOKEN are not set. Add both to " +
        ".env (see .env.example) — generate them in Craft under " +
        "Settings -> Connect/API.",
    );
    this.name = "CraftNotConfiguredError";
  }
}

async function craftRequest(
  method: string,
  pathAndQuery: string,
  body?: unknown,
): Promise<unknown> {
  if (!CRAFT_CONNECT_URL || !CRAFT_API_TOKEN) throw new CraftNotConfiguredError();
  const url = `${CRAFT_CONNECT_URL}${pathAndQuery}`;
  const res = await fetch(url, {
    method,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${CRAFT_API_TOKEN}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Craft API request failed: ${res.status} ${res.statusText} (${url})${detail ? ` — ${detail}` : ""}`,
    );
  }
  return res.json();
}

const craftGet = (pathAndQuery: string) => craftRequest("GET", pathAndQuery);

export async function listCraftDocuments(): Promise<
  { id: string; title: string }[]
> {
  const data = (await craftGet("/documents")) as {
    items: { id: string; title: string }[];
  };
  return data.items;
}

export async function fetchCraftDocument(docId: string): Promise<CraftBlock> {
  return (await craftGet(
    `/blocks?id=${encodeURIComponent(docId)}&maxDepth=-1`,
  )) as CraftBlock;
}

/**
 * Replace a page's direct child blocks wholesale: delete every existing
 * top-level block, then create one plain text block per line (empty strings
 * become blank blocks, used as visual spacing). No diff/merge — callers own
 * that decision (push_status_to_craft treats this doc as bot-owned).
 *
 * Request/response shapes below aren't in Craft's published docs (that site
 * is a JS SPA my fetch tools can't render) — reverse-engineered from the
 * live API's Zod validation error messages during development:
 *   POST /blocks?id=<pageId>   { blocks: [{type:"text", markdown}], position: {position:"end", pageId} }
 *   DELETE /blocks?id=<pageId> { blockIds: [...] }
 */
export async function replaceDocumentBlocks(
  docId: string,
  lines: string[],
): Promise<void> {
  const current = await fetchCraftDocument(docId);
  const existingIds = (current.content ?? []).map((b) => b.id);

  if (existingIds.length > 0) {
    await craftRequest("DELETE", `/blocks?id=${encodeURIComponent(docId)}`, {
      blockIds: existingIds,
    });
  }

  if (lines.length === 0) return;

  await craftRequest("POST", `/blocks?id=${encodeURIComponent(docId)}`, {
    blocks: lines.map((markdown) => ({ type: "text", markdown })),
    position: { position: "end", pageId: docId },
  });
}

/**
 * Extract plain item names from a document's direct child blocks. The real
 * Staples doc turned out to be plain paragraph blocks (one item per line,
 * markdown-list styling is NOT actually used) — this also tolerates an
 * actual bullet/task list if the doc is ever restyled, and strips common
 * markdown list/emphasis syntax either way.
 */
export function extractItemNames(doc: CraftBlock): string[] {
  const children = doc.content ?? [];
  const names: string[] = [];
  for (const block of children) {
    if (block.type !== "text") continue;
    const cleaned = cleanItemLine(block.markdown ?? "");
    if (cleaned) names.push(cleaned);
  }
  return names;
}

function cleanItemLine(markdown: string): string {
  return markdown
    .replace(/^[-*]\s+\[[ xX]\]\s+/, "") // task checkbox: "- [ ] "
    .replace(/^[-*]\s+/, "") // bullet marker: "- " or "* "
    .replace(/^\d+\.\s+/, "") // numbered marker: "1. "
    .replace(/\*\*(.+?)\*\*/g, "$1") // bold
    .replace(/\*(.+?)\*/g, "$1") // italic
    .trim();
}
