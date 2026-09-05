import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AnthropicNotConfiguredError } from "../anthropicClient.js";
import { findBestItemMatch } from "../fuzzy.js";
import { extractReceiptLines, type ReceiptExtraction } from "../receiptVision.js";
import { recomputeItemSummary, todayIso } from "../replenishment.js";
import { newEventId, withDb } from "../storage.js";
import { isoDate, toolError, toolJson } from "./shared.js";

export function registerIngestReceipt(server: McpServer): void {
  server.registerTool(
    "ingest_receipt",
    {
      title: "Ingest receipt",
      description:
        "Extract line items from a photo of a receipt (via one-shot Claude " +
        "vision), fuzzy-match each against the staples list, and record a " +
        "purchase event for every match. Returns unmatched lines so they " +
        "can be reviewed/added manually.",
      inputSchema: {
        image_base64: z
          .string()
          .min(1)
          .describe("Base64-encoded receipt photo, no data: URL prefix"),
        media_type: z
          .enum(["image/jpeg", "image/png", "image/gif", "image/webp"])
          .default("image/jpeg"),
        date: isoDate
          .optional()
          .describe("Purchase date, YYYY-MM-DD; defaults to today"),
        raw_ref: z
          .string()
          .optional()
          .describe("Free-text reference for this receipt, e.g. a filename"),
      },
    },
    async ({ image_base64, media_type, date, raw_ref }) => {
      let extraction: ReceiptExtraction;
      try {
        extraction = await extractReceiptLines(image_base64, media_type);
      } catch (err) {
        if (err instanceof AnthropicNotConfiguredError) {
          return toolError(err.message);
        }
        return toolError(`Receipt vision extraction failed: ${(err as Error).message}`);
      }

      const { lines, order_reference } = extraction;

      if (lines.length === 0) {
        return toolJson({
          matched: [],
          unmatched: [],
          note: "No item lines were extracted from the image.",
        });
      }

      const purchaseDate = date ?? todayIso();
      const reference = raw_ref ?? `receipt-${randomUUID()}`;

      return withDb((db) => {
        // order_reference is the primary dedup key: if this order was
        // already recorded (by either ingest path), skip every line item
        // rather than re-inserting or partially processing. See CLAUDE.md's
        // reconciliation section.
        if (
          order_reference &&
          db.purchase_events.some((e) => e.order_reference === order_reference)
        ) {
          return toolJson({
            matched: [],
            unmatched: [],
            note:
              `Already imported — order ${order_reference} has already been ` +
              `recorded; skipping all ${lines.length} line item(s).`,
          });
        }

        const matched: { line: string; item_name: string }[] = [];
        const unmatched: string[] = [];

        for (const line of lines) {
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
            raw_ref: reference,
            order_reference,
            created_at: new Date().toISOString(),
          });

          const eventsForItem = db.purchase_events.filter(
            (e) => e.item_id === item.item_id,
          );
          recomputeItemSummary(item, eventsForItem);
          item.updated_at = new Date().toISOString();

          matched.push({ line, item_name: item.name });
        }

        return toolJson({ matched, unmatched });
      });
    },
  );
}
