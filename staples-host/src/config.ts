import { existsSync } from "node:fs";
import path from "node:path";

// Load .env if present (local dev / NAS deploy with a mounted .env file).
// Silently skip in environments where env vars are already injected another
// way (e.g. `docker run --env-file`) and no .env is on disk.
if (existsSync(path.resolve(process.cwd(), ".env"))) {
  process.loadEnvFile();
}

// DATA_DIR is the mount point for the Docker volume holding db.json. Default
// points at a local ./data directory so `npm run dev` works out of the box
// without needing a volume — override with the env var for the NAS deploy.
export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(process.cwd(), "data");

export const DB_PATH = path.join(DATA_DIR, "db.json");

export const PORT = process.env.PORT ? Number(process.env.PORT) : 8481;

// Multiplier applied to replenishment_interval_days to distinguish "due"
// from "overdue". Not specified in the project brief — documented here as a
// tunable default rather than a hardcoded magic number.
export const OVERDUE_MULTIPLIER = 1.5;

// Fuzzy-match threshold (Fuse.js score, 0 = perfect match, 1 = no match).
// Below this score a match is accepted; above it, treated as "not found".
export const FUZZY_MATCH_THRESHOLD = 0.4;

// Craft Connect share link + the document ID of the Staples list within it,
// plus the API token sent as `Authorization: Bearer <token>`. The link path
// alone isn't sufficient — see README.
export const CRAFT_CONNECT_URL = process.env.CRAFT_CONNECT_URL ?? null;
export const CRAFT_STAPLES_DOC_ID = process.env.CRAFT_STAPLES_DOC_ID ?? null;
export const CRAFT_API_TOKEN = process.env.CRAFT_API_TOKEN ?? null;

// Separate, bot-owned doc that push_status_to_craft() overwrites wholesale.
// Never read by sync_from_craft() — see README for why that'd be a pull/push
// loop. Created manually by the user; this server never creates it.
export const CRAFT_STATUS_DOC_ID = process.env.CRAFT_STATUS_DOC_ID ?? null;

// Used by ingest_receipt for one-shot vision extraction of receipt line
// items via the Anthropic Messages API — a single stateless API call, not
// an Agent SDK session, so it doesn't touch the warm-session constraint in
// CLAUDE.md.
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? null;
export const RECEIPT_VISION_MODEL =
  process.env.RECEIPT_VISION_MODEL ?? "claude-sonnet-5";
