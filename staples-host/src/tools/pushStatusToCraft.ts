import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CRAFT_STATUS_DOC_ID } from "../config.js";
import { CraftNotConfiguredError, replaceDocumentBlocks } from "../craft.js";
import { computeStatus, daysSince } from "../replenishment.js";
import { readDb } from "../storage.js";
import type { Item, PurchaseEvent } from "../types.js";
import { toolError, toolJson } from "./shared.js";

interface Section {
  emoji: string;
  title: string;
  items: Item[];
}

function groupByUrgency(items: Item[], purchaseEvents: PurchaseEvent[]): Section[] {
  const overdue: Item[] = [];
  const due: Item[] = [];
  const stocked: Item[] = [];
  const neverTracked: Item[] = [];
  const noData: Item[] = [];

  for (const item of items) {
    if (item.replenishment_interval_days == null) {
      // No interval at all, neither seeded nor learned.
      noData.push(item);
    } else if (!item.last_purchased) {
      // Interval seeded via set_interval with no anchor date -> status is
      // "due" per computeStatusFromAnchor, but kept visually separate from
      // genuinely-computed Due soon/Overdue items, since there's no real
      // date behind it (per CLAUDE.md's "❔ Never tracked" section).
      neverTracked.push(item);
    } else {
      // Derived fresh, not trusted from the stored item.status -- see
      // listStaples.ts/getItem.ts for why (a write-time cache that should
      // never be assumed current). The interval_days==null and
      // no-last_purchased cases are already handled above, so this branch
      // always has a real anchor to compute against.
      const eventCount = purchaseEvents.filter((e) => e.item_id === item.item_id).length;
      const status = computeStatus(item, eventCount);
      if (status === "overdue") overdue.push(item);
      else if (status === "due") due.push(item);
      else stocked.push(item);
    }
  }

  const byName = (a: Item, b: Item) => a.name.localeCompare(b.name);
  return [
    { emoji: "⚠️", title: "Overdue", items: overdue.sort(byName) },
    { emoji: "🟡", title: "Due soon", items: due.sort(byName) },
    { emoji: "✅", title: "Stocked", items: stocked.sort(byName) },
    { emoji: "❔", title: "Never tracked", items: neverTracked.sort(byName) },
    { emoji: "❔", title: "Not enough data yet", items: noData.sort(byName) },
  ];
}

function itemLine(item: Item): string {
  if (item.replenishment_interval_days == null) {
    return `- ${item.name} — no interval learned yet`;
  }
  if (!item.last_purchased) {
    return `- ${item.name} — no purchase on record yet (usually every ~${item.replenishment_interval_days} days)`;
  }
  const days = daysSince(item.last_purchased);
  return `- ${item.name} — last bought ${days} days ago (usually every ~${item.replenishment_interval_days} days)`;
}

function buildStatusLines(items: Item[], purchaseEvents: PurchaseEvent[]): string[] {
  const lines: string[] = [
    "Quartermaster — Staples Status",
    `Last updated: ${new Date().toISOString()}`,
  ];

  // Sections with no items are omitted entirely rather than shown empty —
  // not specified in CLAUDE.md's template, chosen for a cleaner at-a-glance
  // read (no "⚠️ Overdue" header sitting above nothing).
  for (const section of groupByUrgency(items, purchaseEvents)) {
    if (section.items.length === 0) continue;
    lines.push("", `${section.emoji} ${section.title}`);
    for (const item of section.items) lines.push(itemLine(item));
  }

  return lines;
}

export function registerPushStatusToCraft(server: McpServer): void {
  server.registerTool(
    "push_status_to_craft",
    {
      title: "Push status to Craft",
      description:
        "Write current staple status (grouped by urgency: overdue, due " +
        "soon, stocked, never tracked, not enough data) to the separate, bot-owned " +
        "\"Staples Status\" Craft doc. Wholesale overwrite every time — no " +
        "diff/merge against prior content, since this doc is never " +
        "hand-edited. Does not read from or affect the source Staples doc " +
        "that sync_from_craft() uses.",
    },
    async () => {
      if (!CRAFT_STATUS_DOC_ID) {
        return toolError(
          "CRAFT_STATUS_DOC_ID is not set. Add it to .env (see .env.example) " +
            "— it must point at a Staples Status doc you've already created " +
            "in Craft; this tool never creates the doc itself.",
        );
      }

      const db = await readDb();
      const lines = buildStatusLines(db.items, db.purchase_events);

      try {
        await replaceDocumentBlocks(CRAFT_STATUS_DOC_ID, lines);
      } catch (err) {
        if (err instanceof CraftNotConfiguredError) {
          return toolError(err.message);
        }
        return toolError(`Failed to push status to Craft: ${(err as Error).message}`);
      }

      const counts = Object.fromEntries(
        groupByUrgency(db.items, db.purchase_events).map((s) => [s.title, s.items.length]),
      );
      return toolJson({ pushed: true, counts });
    },
  );
}
