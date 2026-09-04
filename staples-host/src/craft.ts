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

async function craftGet(pathAndQuery: string): Promise<unknown> {
  if (!CRAFT_CONNECT_URL || !CRAFT_API_TOKEN) throw new CraftNotConfiguredError();
  const url = `${CRAFT_CONNECT_URL}${pathAndQuery}`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${CRAFT_API_TOKEN}`,
    },
  });
  if (!res.ok) {
    throw new Error(
      `Craft API request failed: ${res.status} ${res.statusText} (${url})`,
    );
  }
  return res.json();
}

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
