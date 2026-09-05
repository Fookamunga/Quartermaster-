import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AnthropicNotConfiguredError } from "../anthropicClient.js";
import { findBestItemMatch } from "../fuzzy.js";
import { extractOrderText } from "../orderTextExtraction.js";
import { recomputeItemSummary, todayIso } from "../replenishment.js";
import { newEventId, withDb } from "../storage.js";
import { isoDate, toolError, toolJson } from "./shared.js";

export function registerIngestOrderText(server: McpServer): void {
  server.registerTool(
    "ingest_order_text",
    {
      title: "Ingest order text",
      description:
        "Extract line items and a purchase date from pasted grocery order " +
        "text (a full order-confirmation/invoice paste, or a shorter, " +
        "header-less list) via one-shot Claude text extraction, fuzzy-match " +
        "each item against the staples list, and record a purchase event " +
        "for every match. Returns unmatched lines so they can be reviewed/" +
        "added manually. Mirrors ingest_receipt's design for text instead " +
        "of a photo — callers should hand over raw pasted text as-is, not " +
        "pre-parse it themselves.",
      inputSchema: {
        text: z.string().min(1).describe("Raw pasted order text"),
        date: isoDate
          .optional()
          .describe(
            "Purchase date, YYYY-MM-DD, if already known. Otherwise extracted " +
              "from an order-confirmation header or a date stated within the " +
              "text, defaulting to today if neither is found.",
          ),
        raw_ref: z
          .string()
          .optional()
          .describe(
            "Free-text reference, e.g. an order/invoice ID, if already known. " +
              "Otherwise taken from an order-confirmation header if present.",
          ),
      },
    },
    async ({ text, date, raw_ref }) => {
      let extraction;
      try {
        extraction = await extractOrderText(text);
      } catch (err) {
        if (err instanceof AnthropicNotConfiguredError) {
          return toolError(err.message);
        }
        return toolError(`Order text extraction failed: ${(err as Error).message}`);
      }

      if (extraction.items.length === 0) {
        return toolJson({
          matched: [],
          unmatched: [],
          note: "No item lines were extracted from the text.",
        });
      }

      const purchaseDate = date ?? extraction.date ?? todayIso();
      const orderReference = extraction.order_reference;
      const reference = raw_ref ?? orderReference ?? null;

      return withDb((db) => {
        // order_reference is the primary dedup key: if this order was
        // already recorded (by either ingest path), skip every line item
        // rather than re-inserting or partially processing. See CLAUDE.md's
        // reconciliation section.
        if (
          orderReference &&
          db.purchase_events.some((e) => e.order_reference === orderReference)
        ) {
          return toolJson({
            matched: [],
            unmatched: [],
            note:
              `Already imported — order ${orderReference} has already been ` +
              `recorded; skipping all ${extraction.items.length} line item(s).`,
            date: purchaseDate,
          });
        }

        const matched: { line: string; item_name: string }[] = [];
        const unmatched: string[] = [];

        for (const line of extraction.items) {
          const item = findBestItemMatch(db.items, line);
          if (!item) {
            unmatched.push(line);
            continue;
          }

          db.purchase_events.push({
            event_id: newEventId(),
            item_id: item.item_id,
            date: purchaseDate,
            source: "receipt_scan",
            raw_ref: reference ?? line,
            order_reference: orderReference,
            created_at: new Date().toISOString(),
          });

          const eventsForItem = db.purchase_events.filter(
            (e) => e.item_id === item.item_id,
          );
          recomputeItemSummary(item, eventsForItem);
          item.updated_at = new Date().toISOString();

          matched.push({ line, item_name: item.name });
        }

        return toolJson({ matched, unmatched, date: purchaseDate });
      });
    },
  );
}
