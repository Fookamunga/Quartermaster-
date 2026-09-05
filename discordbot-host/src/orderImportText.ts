import { STAPLES_HOST_URL } from "./config.js";
import { callTool, toolResultJson, toolResultText } from "./mcpClient.js";
import type { IngestResult } from "./orderImportRelay.js";

/**
 * Calls staples-host's ingest_order_text directly, host-side -- no cold
 * Claude session involved. All parsing logic (date extraction from an
 * order-confirmation header or a stated date, category-line filtering,
 * fuzzy-matching, recording) lives entirely in staples-host; discordbot-host
 * only relays the raw pasted text in and a structured result back out.
 * Closes the same architectural gap the photo relay closed: a plain
 * Claude.ai conversation with a staples-tracker-mcp connector can call
 * ingest_order_text directly and get an identical result, with zero
 * discordbot-host involvement. See CLAUDE.md's order-import section.
 */
export async function ingestOrderText(text: string): Promise<IngestResult> {
  const result = await callTool("discordbot-order-import", STAPLES_HOST_URL, "ingest_order_text", {
    text,
  });

  if (result.isError) {
    throw new Error(toolResultText(result));
  }
  return toolResultJson<IngestResult>(result);
}
