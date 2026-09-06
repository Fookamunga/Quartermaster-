import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AnthropicNotConfiguredError } from "../anthropicClient.js";
import { extractOrderText } from "../orderTextExtraction.js";
import { todayIso } from "../replenishment.js";
import { withDb } from "../storage.js";
import { recordOrderLines } from "./orderLineRecording.js";
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
          already_recorded: [],
          unmatched: [],
          note: "No item lines were extracted from the text.",
        });
      }

      const purchaseDate = date ?? extraction.date ?? todayIso();
      const orderReference = extraction.order_reference;
      const reference = raw_ref ?? orderReference ?? null;

      return withDb((db) => {
        const { matched, already_recorded, unmatched } = recordOrderLines(
          db,
          extraction.items,
          purchaseDate,
          orderReference,
          (line) => reference ?? line,
        );
        return toolJson({ matched, already_recorded, unmatched, date: purchaseDate });
      });
    },
  );
}
