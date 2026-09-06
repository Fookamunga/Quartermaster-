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

// Secret path segment required on the /mcp/<token> route. ALLOWED_HOSTS below
// is only a Host-header allowlist (DNS-rebinding protection) -- anyone who
// knows the Funnel hostname can already send a matching Host header, so it's
// not real authentication. This token is the actual gate against internet-
// wide discovery of the Funnel endpoint, mirroring woolies-mcp's /mcp/<token>
// pattern. No default: an unset token fails closed (see index.ts) rather than
// silently exposing the endpoint.
export const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN ?? null;

// Multiplier applied to replenishment_interval_days to distinguish "due"
// from "overdue". Not specified in the project brief — documented here as a
// tunable default rather than a hardcoded magic number.
export const OVERDUE_MULTIPLIER = 1.5;

// Fuzzy-match threshold (Fuse.js score, 0 = perfect match, 1 = no match).
// Below this score a match is accepted; above it, treated as "not found".
export const FUZZY_MATCH_THRESHOLD = 0.4;

// Used by ingest_receipt (vision) and ingest_order_text (text) for one-shot
// extraction calls via the Anthropic Messages API — each a single stateless
// API call, not an Agent SDK session, so neither touches the warm-session
// constraint in CLAUDE.md.
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? null;
export const EXTRACTION_MODEL = process.env.EXTRACTION_MODEL ?? "claude-sonnet-5";

// Output budget for both one-shot extraction calls (receipt vision, order-
// text parsing). Confirmed live against a real 3-page, ~29-item order
// confirmation that the previous 1024 was nowhere near enough: with no
// `thinking` param set, this model defaults to adaptive thinking, which
// alone consumed 749 of the 1024 tokens on that document before writing any
// visible output, truncating the JSON mid-array and silently producing an
// empty result. Both extraction calls now explicitly set
// `thinking: { type: "disabled" }` (thinking adds no value for a mechanical
// extract-into-JSON task), so this budget is for visible output only --
// re-verified against that same real document afterward: all 29 items
// extracted cleanly, comfortable headroom left in this budget. Sized with
// real margin for a larger order too, not just enough to pass one test case.
export const EXTRACTION_MAX_TOKENS = process.env.EXTRACTION_MAX_TOKENS
  ? Number(process.env.EXTRACTION_MAX_TOKENS)
  : 4096;

// Discord webhook URL for the weekly restock report (see weeklyReportSentry.ts)
// -- staples-host posts directly, bypassing discordbot-host's conversational
// flow entirely, since this is staples-host's own scheduled job, not
// something that should require an active Discord bot session. No default:
// unset means the sentry still runs its weekly check but skips posting,
// logging a warning once at startup -- same "unset degrades gracefully,
// never a hard failure" convention as WOOLIES_MCP_URL/MCP_AUTH_TOKEN.
export const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL ?? null;

// How often the weekly-report sentry checks whether it's currently Sunday
// 5pm NZ time -- default 15 min, fine-grained enough to reliably catch that
// one-hour window without needing second-level precision for a once-a-week
// digest. See weeklyReportSentry.ts.
export const WEEKLY_REPORT_CHECK_INTERVAL_MS = process.env.WEEKLY_REPORT_CHECK_INTERVAL_MS
  ? Number(process.env.WEEKLY_REPORT_CHECK_INTERVAL_MS)
  : 15 * 60 * 1000;

// woolies-mcp's own MCP endpoint (the same Funnel URL used elsewhere, e.g.
// https://<funnel-host>/mcp/<token>). Used only by suggest_alternatives, to
// re-resolve a historical product_name to a live product via woolies-mcp's
// own search_products tool -- staples-host's one narrow, read-only exception
// to never calling woolies-mcp itself. See CLAUDE.md's Ownership boundaries.
// Null means suggest_alternatives can't resolve anything and returns an
// empty list rather than guessing -- never a hard failure for the rest of
// staples-host.
export const WOOLIES_MCP_URL = process.env.WOOLIES_MCP_URL ?? null;
