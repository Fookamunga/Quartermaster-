import { getAnthropicClient } from "./anthropicClient.js";
import { EXTRACTION_MAX_TOKENS, EXTRACTION_MODEL } from "./config.js";
import { assertCleanCompletion, extractJsonObject } from "./extractionGuard.js";

export interface ReceiptExtraction {
  lines: { name: string; quantity: number }[];
  // Order/invoice number, e.g. an online order receipt showing "Order
  // Confirmation/Invoice Number CD47859895" near the top. In-store receipts
  // usually won't have one -- null in that case.
  order_reference: string | null;
}

const EXTRACTION_PROMPT = `You are looking at a photo of a grocery store receipt.

Extract two things:

1. Every purchased grocery/household item, one per line, as its plain
   product name (stripped of price, SKU, and store/tax/total lines --
   normalize away store abbreviations where obvious, e.g. "MLK 2L" ->
   "Milk 2L") together with the quantity purchased. If a line doesn't show
   a quantity (most single-unit lines won't), use 1.
2. An order/invoice reference number, if present -- e.g. an online order
   receipt showing "Order Confirmation/Invoice Number CD47859895" near the
   top. In-store receipts usually won't have one; use null in that case.

Respond with ONLY a JSON object of this exact shape, nothing else:
{"order_reference": "<id>" or null, "items": [{"name": "<item name>", "quantity": <number>}, ...]}
If you can't read any items, use an empty items array.`;

/**
 * One-shot Anthropic Messages API vision call — NOT an Agent SDK session.
 * See CLAUDE.md's non-negotiable constraint: this is a single stateless
 * completion request, not a warm query()+resume loop with MCP servers
 * registered, so it doesn't touch that failure mode.
 */
export async function extractReceiptLines(
  imageBase64: string,
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp",
): Promise<ReceiptExtraction> {
  const client = getAnthropicClient("ingest_receipt's vision extraction");
  const response = await client.messages.create({
    model: EXTRACTION_MODEL,
    max_tokens: EXTRACTION_MAX_TOKENS,
    // See orderTextExtraction.ts's identical setting: a mechanical
    // extract-into-JSON task gets nothing from thinking, and leaving it to
    // default to adaptive thinking is exactly what ate the output budget on
    // a real large order text extraction -- same risk applies here for a
    // large/complex receipt photo.
    thinking: { type: "disabled" },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mediaType, data: imageBase64 },
          },
          { type: "text", text: EXTRACTION_PROMPT },
        ],
      },
    ],
  });

  assertCleanCompletion(response, "Receipt vision extraction");

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Receipt vision extraction returned no text content.");
  }

  return parseExtraction(textBlock.text);
}

function parseExtraction(text: string): ReceiptExtraction {
  const parsed = extractJsonObject(text, "Receipt vision extraction");
  const lines = Array.isArray(parsed.items)
    ? parsed.items
        .filter(
          (v: unknown): v is { name: unknown; quantity: unknown } =>
            typeof v === "object" && v !== null && "name" in v,
        )
        .filter((v): v is { name: string; quantity: unknown } =>
          typeof v.name === "string" && v.name.trim().length > 0,
        )
        .map((v) => ({
          name: v.name,
          quantity:
            typeof v.quantity === "number" && Number.isFinite(v.quantity) && v.quantity > 0
              ? v.quantity
              : 1,
        }))
    : [];
  const order_reference =
    typeof parsed.order_reference === "string" && parsed.order_reference.trim().length > 0
      ? parsed.order_reference
      : null;
  return { lines, order_reference };
}
