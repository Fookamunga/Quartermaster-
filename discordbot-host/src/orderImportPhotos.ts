import { readFileSync } from "node:fs";
import path from "node:path";
import { STAPLES_HOST_URL } from "./config.js";
import { callTool, toolResultJson, toolResultText } from "./mcpClient.js";
import type { IngestResult } from "./orderImportRelay.js";

/**
 * Calls staples-host's ingest_receipt directly, host-side -- no cold Claude
 * session involved. All receipt-processing logic (vision extraction,
 * fuzzy-matching, recording, last_purchased updates) lives entirely in
 * staples-host; discordbot-host only relays bytes in and a structured
 * result back out. See CLAUDE.md's order-import architecture section.
 *
 * This replaces an earlier design where the cold session's own agent
 * base64-encoded the file via Bash and called the tool itself. That broke
 * at realistic photo sizes: a ~130,000-character base64 string is not
 * something an agent can reliably read back to construct a tool call with,
 * and isn't something Claude reasoning was ever needed for in the first
 * place -- it's mechanical plumbing, the same category of work the sentries
 * and pending-action execution already do as plain host-side MCP calls.
 */

const MEDIA_TYPE_BY_EXT: Record<string, "image/jpeg" | "image/png" | "image/gif" | "image/webp"> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function mediaTypeFor(filePath: string): "image/jpeg" | "image/png" | "image/gif" | "image/webp" {
  return MEDIA_TYPE_BY_EXT[path.extname(filePath).toLowerCase()] ?? "image/jpeg";
}

export async function ingestReceiptPhoto(
  absoluteFilePath: string,
  rawRef: string,
): Promise<IngestResult> {
  const bytes = readFileSync(absoluteFilePath);
  const result = await callTool("discordbot-order-import", STAPLES_HOST_URL, "ingest_receipt", {
    image_base64: bytes.toString("base64"),
    media_type: mediaTypeFor(absoluteFilePath),
    raw_ref: rawRef,
  });

  if (result.isError) {
    throw new Error(toolResultText(result));
  }
  return toolResultJson<IngestResult>(result);
}
