import { getAnthropicClient } from "./anthropicClient.js";
import { EXTRACTION_MODEL } from "./config.js";
import { todayIso } from "./replenishment.js";

export interface OrderTextExtraction {
  date: string | null; // YYYY-MM-DD
  invoice_id: string | null;
  items: string[];
}

function buildPrompt(referenceDate: string): string {
  return `You are reading pasted grocery order text — either a full order
confirmation/invoice, or a shorter informal list of items someone bought.

Extract two things:

1. A purchase date, if you can determine one, in this priority order:
   a. A header line like "Order Confirmation/Invoice Number <ID> <DD Mon, YYYY>"
      — extract that date (converted to YYYY-MM-DD) and the invoice/order ID.
   b. Otherwise, a date mentioned informally elsewhere in the text (e.g. "bought
      this on the 3rd", "last Tuesday") — resolve it relative to today,
      ${referenceDate}, and convert to YYYY-MM-DD.
   c. Otherwise, leave date as null (the caller will default it).

2. Every purchased item's plain product name, one per line item. Lines that are
   category/section headers (e.g. "Chocolate, Sweets & Snacks", "Dairy" — no
   leading item reference number or quantity) are NOT items — skip them. Ignore
   price, quantity, SKU, and order/ref-number columns; extract just the product
   name/description. Real pastes from an order-confirmation page/PDF often lose
   exact column alignment — use judgment on where the item name starts and ends,
   the way you'd read it yourself.

Respond with ONLY a JSON object of this exact shape, nothing else:
{"date": "YYYY-MM-DD" or null, "invoice_id": "<id>" or null, "items": ["<item name>", ...]}
If you can't find any items, use an empty items array.`;
}

/**
 * One-shot Anthropic Messages API text-extraction call — NOT an Agent SDK
 * session. Mirrors receiptVision.ts's extractReceiptLines() but for pasted
 * text instead of a photo; same reasoning re: the non-negotiable
 * warm-session constraint in CLAUDE.md applies (single stateless request).
 */
export async function extractOrderText(text: string): Promise<OrderTextExtraction> {
  const client = getAnthropicClient("ingest_order_text's text extraction");
  const response = await client.messages.create({
    model: EXTRACTION_MODEL,
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: `${buildPrompt(todayIso())}\n\n---\n\n${text}` }],
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    return { date: null, invoice_id: null, items: [] };
  }

  return parseExtraction(textBlock.text);
}

function parseExtraction(text: string): OrderTextExtraction {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { date: null, invoice_id: null, items: [] };

  try {
    const parsed = JSON.parse(match[0]);
    const items = Array.isArray(parsed.items)
      ? parsed.items.filter(
          (v: unknown): v is string => typeof v === "string" && v.trim().length > 0,
        )
      : [];
    const date =
      typeof parsed.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date)
        ? parsed.date
        : null;
    const invoice_id =
      typeof parsed.invoice_id === "string" && parsed.invoice_id.trim().length > 0
        ? parsed.invoice_id
        : null;
    return { date, invoice_id, items };
  } catch {
    return { date: null, invoice_id: null, items: [] };
  }
}
