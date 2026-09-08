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

// One candidate-reaction message's worth of content -- used by both the
// single-item disambiguation flow and (as of the recipe extension) the
// Recipe/Multi-Ingredient flow, one entry per ingredient that needs a
// choice (see candidateReactions.ts). No pricingUnit needed: execution goes
// through staples-host's own set_cart_quantity tool (added for cart-write
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
//
// best_value is always null for a recipe-sourced entry -- build_shopping_list
// never computes one (removed entirely after a real production timeout; see
// CLAUDE.md's "Scale fix" history). Not something this extension reintroduces.
export interface CandidateOptions {
  summary: string;
  top_pick: CandidateOption | null;
  other_candidates: CandidateOption[];
  best_value: CandidateOption | null;
}

// The file (candidate-options.json) is always an array now, whether it came
// from a single-item request (one entry, or the file is simply absent if
// the request needed no choice) or a recipe request (one entry per
// ingredient that needs a choice -- already-stocked and single-obvious-match
// ingredients never get an entry at all, see the workspace CLAUDE.md).
// Posted as a sequence of separate Discord messages, one per entry, never
// combined into one -- that's the exact clutter problem the whole reaction
// mechanism was scoped away from for multi-item requests originally.
export type CandidateOptionsFile = CandidateOptions[];

export interface CandidateOption {
  name: string;
  sku: string;
}
