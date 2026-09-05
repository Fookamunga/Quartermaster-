import { readFileSync } from "node:fs";
import path from "node:path";
import { STAPLES_HOST_URL } from "./config.js";
import { callTool, toolResultJson, toolResultText } from "./mcpClient.js";

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

interface IngestReceiptResult {
  matched: { line: string; item_name: string }[];
  unmatched: string[];
  note?: string;
}

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
): Promise<IngestReceiptResult> {
  const bytes = readFileSync(absoluteFilePath);
  const result = await callTool("discordbot-order-import", STAPLES_HOST_URL, "ingest_receipt", {
    image_base64: bytes.toString("base64"),
    media_type: mediaTypeFor(absoluteFilePath),
    raw_ref: rawRef,
  });

  if (result.isError) {
    throw new Error(toolResultText(result));
  }
  return toolResultJson<IngestReceiptResult>(result);
}

export function formatIngestReceiptResult(result: IngestReceiptResult): string {
  const lines: string[] = [];
  if (result.matched.length > 0) {
    lines.push("Recorded:");
    for (const m of result.matched) lines.push(`• ${m.item_name} (from "${m.line}")`);
  }
  if (result.unmatched.length > 0) {
    lines.push("Unmatched — no matching staple found, add it manually via Craft if it should be tracked:");
    for (const line of result.unmatched) lines.push(`• ${line}`);
  }
  if (lines.length === 0) {
    lines.push(result.note ?? "No items were found in that photo.");
  }
  return lines.join("\n");
}
