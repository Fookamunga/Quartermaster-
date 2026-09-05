import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_API_KEY } from "./config.js";

// Shared by every one-shot extraction call (receipt vision, order-text
// parsing) — each is a single stateless Messages API request, not an Agent
// SDK session, so none of them touch the warm-session constraint in
// CLAUDE.md. See receiptVision.ts and orderTextExtraction.ts.
export class AnthropicNotConfiguredError extends Error {
  constructor(toolName: string) {
    super(
      `ANTHROPIC_API_KEY is not set. Add it to .env (see .env.example) to enable ${toolName}.`,
    );
    this.name = "AnthropicNotConfiguredError";
  }
}

export function getAnthropicClient(toolName: string): Anthropic {
  if (!ANTHROPIC_API_KEY) throw new AnthropicNotConfiguredError(toolName);
  return new Anthropic({ apiKey: ANTHROPIC_API_KEY });
}
