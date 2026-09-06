import type Anthropic from "@anthropic-ai/sdk";

/**
 * Both one-shot extraction calls (receipt vision, order-text parsing) used
 * to silently degrade into an empty result whenever the model's response
 * was truncated or didn't contain parseable JSON -- confirmed live against
 * a real 3-page, ~20-item order confirmation: the response hit
 * `stop_reason: "max_tokens"` mid-array, and the regex-based JSON search
 * found no closing brace, so it silently returned `{ items: [] }` with no
 * error anywhere. That's indistinguishable from "this document genuinely
 * has no items," which is a real, legitimate result the prompt explicitly
 * allows -- so a truncated/malformed response needs to fail loudly instead,
 * not degrade into the same shape as a legitimate empty one.
 *
 * `end_turn` is the only stop_reason that means "the model finished
 * writing, nothing was cut off." Every other value (`max_tokens`,
 * `stop_sequence`, `tool_use`, `pause_turn`, `refusal`,
 * `model_context_window_exceeded`) means the response can't be trusted as
 * complete.
 */
export function assertCleanCompletion(response: Anthropic.Message, context: string): void {
  if (response.stop_reason !== "end_turn") {
    throw new Error(
      `${context} did not complete cleanly (stop_reason: ${response.stop_reason}) -- ` +
        "the response may be truncated rather than genuinely empty. If this keeps happening, " +
        "EXTRACTION_MAX_TOKENS may need to be raised further.",
    );
  }
}

/**
 * Finds and parses the (single, whole-response) JSON object both extraction
 * prompts are instructed to reply with. Throws -- doesn't return an empty
 * default -- if no `{...}` is found or it doesn't parse, since by the time
 * this runs assertCleanCompletion has already confirmed the response wasn't
 * truncated: a well-formed complete response should always contain valid
 * JSON, so a failure here means the model didn't follow the format, not
 * that there's nothing to extract.
 */
export function extractJsonObject(text: string, context: string): Record<string, unknown> {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error(`${context} response did not contain a parseable JSON object.`);
  }
  return JSON.parse(match[0]) as Record<string, unknown>;
}
