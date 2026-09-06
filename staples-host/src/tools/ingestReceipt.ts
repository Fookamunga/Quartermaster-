import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AnthropicNotConfiguredError } from "../anthropicClient.js";
import { extractReceiptLines, type ReceiptExtraction } from "../receiptVision.js";
import { todayIso } from "../replenishment.js";
import { withDb } from "../storage.js";
import { recordOrderLines } from "./orderLineRecording.js";
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
          already_recorded: [],
          unmatched: [],
          note: "No item lines were extracted from the image.",
        });
      }

      const purchaseDate = date ?? todayIso();
      const reference = raw_ref ?? `receipt-${randomUUID()}`;

      return withDb((db) => {
        const { matched, already_recorded, unmatched } = recordOrderLines(
          db,
          lines,
          purchaseDate,
          order_reference,
          () => reference,
        );
        return toolJson({ matched, already_recorded, unmatched });
      });
    },
  );
}
