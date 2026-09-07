export type ChannelKey = "woolworths-ordering" | "order-import";

export interface RemoteMcpServerConfig {
  url: string;
  headers?: Record<string, string>;
}

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  channelKey: ChannelKey;
  mcpServers: Record<string, RemoteMcpServerConfig>;
}

export interface ContainerOutput {
  status: "success" | "error";
  result: string | null;
  newSessionId?: string;
  error?: string;
}

export interface ProposeAction {
  summary: string;
  items: PendingActionItem[];
}

export interface PendingActionItem {
  name?: string;
  sku: string | number;
  quantity: number;
  pricingUnit?: "EACH" | "KG";
}

// Single-item disambiguation flow only (see candidateReactions.ts) --
// recipe/multi-item shopping-list replies stay on the existing typed-reply
// flow, unaffected by this. No pricingUnit needed: execution goes through
// staples-host's own set_cart_quantity tool (added for cart-write
// restoration), which resolves the purchasing unit itself.
//
// Each field maps to exactly one reaction, never a number for top_pick or
// best_value -- a real rendering bug (confirmed live, message 1546641091296497794)
// numbered every candidate uniformly, including top_pick and best_value,
// when only other_candidates should ever be numbered. top_pick -> ✅ only,
// best_value -> 💰 only, other_candidates -> 1️⃣.. up to 5 (matching
// suggest_alternatives' own MAX_CANDIDATES cap). If best_value duplicates
// top_pick or an other_candidates entry, that duplicate sku must not appear
// twice: it's represented by whichever field already covers it (top_pick or
// best_value), never both, and never removed from other_candidates only to
// reappear unnumbered without also being excluded there.
export interface CandidateOptions {
  summary: string;
  top_pick: CandidateOption | null;
  other_candidates: CandidateOption[];
  best_value: CandidateOption | null;
}

export interface CandidateOption {
  name: string;
  sku: string;
}
