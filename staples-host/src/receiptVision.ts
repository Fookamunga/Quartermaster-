import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_API_KEY, RECEIPT_VISION_MODEL } from "./config.js";

export class VisionNotConfiguredError extends Error {
  constructor() {
    super(
      "ANTHROPIC_API_KEY is not set. Add it to .env (see .env.example) to " +
        "enable ingest_receipt's vision extraction.",
    );
    this.name = "VisionNotConfiguredError";
  }
}

const EXTRACTION_PROMPT = `You are looking at a photo of a grocery store receipt.
List every purchased grocery/household item as a plain product name, one per line,
stripped of price, quantity, SKU, and store/tax/total lines. Normalize away store
abbreviations where obvious (e.g. "MLK 2L" -> "Milk 2L"). Respond with ONLY a JSON
array of strings, nothing else. If you can't read any items, respond with [].`;

/**
 * One-shot Anthropic Messages API vision call — NOT an Agent SDK session.
 * See CLAUDE.md's non-negotiable constraint: this is a single stateless
 * completion request, not a warm query()+resume loop with MCP servers
 * registered, so it doesn't touch that failure mode.
 */
export async function extractReceiptLines(
  imageBase64: string,
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp",
): Promise<string[]> {
  if (!ANTHROPIC_API_KEY) throw new VisionNotConfiguredError();

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: RECEIPT_VISION_MODEL,
    max_tokens: 1024,
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

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") return [];

  return parseJsonStringArray(textBlock.text);
}

function parseJsonStringArray(text: string): string[] {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  } catch {
    return [];
  }
}
