// Shared shape/formatting for staples-host's ingest_receipt and
// ingest_order_text results -- both return matched/unmatched line items in
// the same shape, so #order-import's photo and text relays share this
// rather than duplicating formatting logic. See orderImportPhotos.ts and
// orderImportText.ts.
export interface IngestResult {
  matched: { line: string; item_name: string }[];
  // Matched a staple, but that item already has a purchase_event under this
  // order's reference number -- a duplicate line, not a new purchase. See
  // CLAUDE.md's "Order-reference dedup" section: dedup is per-line, not
  // per-order, so a multi-page paste of one order correctly reports its
  // repeated lines here while still recording the genuinely new ones.
  already_recorded: { line: string; item_name: string }[];
  unmatched: string[];
  note?: string;
}

export function formatIngestResult(result: IngestResult): string {
  const lines: string[] = [];
  if (result.matched.length > 0) {
    lines.push("Recorded:");
    for (const m of result.matched) lines.push(`• ${m.item_name} (from "${m.line}")`);
  }
  if (result.already_recorded.length > 0) {
    lines.push("Already recorded (skipped duplicate):");
    for (const m of result.already_recorded) lines.push(`• ${m.item_name} (from "${m.line}")`);
  }
  if (result.unmatched.length > 0) {
    lines.push("Unmatched — no matching staple found, add it manually via Craft if it should be tracked:");
    for (const line of result.unmatched) lines.push(`• ${line}`);
  }
  if (lines.length === 0) {
    lines.push(result.note ?? "Nothing was found to record.");
  }
  return lines.join("\n");
}
