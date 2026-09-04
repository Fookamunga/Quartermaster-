import { existsSync } from "node:fs";
import path from "node:path";

if (existsSync(path.resolve(process.cwd(), ".env"))) {
  process.loadEnvFile();
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const DISCORD_BOT_TOKEN = required("DISCORD_BOT_TOKEN");

// Channels are resolved by name at startup, never created -- both already
// exist in the Discord server. See CLAUDE.md's discordbot-host Trigger
// section.
export const WOOLWORTHS_ORDERING_CHANNEL_NAME =
  process.env.WOOLWORTHS_ORDERING_CHANNEL_NAME || "woolworths-ordering";
export const ORDER_IMPORT_CHANNEL_NAME =
  process.env.ORDER_IMPORT_CHANNEL_NAME || "order-import";

export const WOOLIES_MCP_URL = required("WOOLIES_MCP_URL");
export const STAPLES_HOST_URL = required("STAPLES_HOST_URL");

export const PROJECT_ROOT = process.cwd();
export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(PROJECT_ROOT, "data");
export const WORKSPACES_DIR = path.resolve(PROJECT_ROOT, "workspaces");

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || "discordbot-agent:latest";
export const CONTAINER_TIMEOUT_MS = parseInt(
  process.env.CONTAINER_TIMEOUT_MS || "300000",
  10,
); // 5 min default -- matches the ~1.5 min/message latency budget with headroom
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || "10485760",
  10,
); // 10MB

// Woolworths auth-failure sentry: poll interval, and how often to repeat the
// alert while still down (never spam every poll). See CLAUDE.md.
export const AUTH_CHECK_INTERVAL_MS = parseInt(
  process.env.AUTH_CHECK_INTERVAL_MS || String(30 * 60 * 1000),
  10,
);
export const AUTH_ALERT_REPEAT_MS = parseInt(
  process.env.AUTH_ALERT_REPEAT_MS || String(24 * 60 * 60 * 1000),
  10,
);

// "Never tracked" sentry: poll interval. NEVER_TRACKED_TEST_MODE=true runs
// the check once immediately on startup (in addition to the normal interval
// loop) so the filter logic can be verified without waiting up to 6h for
// real data -- it only changes *when* the check runs, never the
// no-interval-items-excluded behavior itself. See CLAUDE.md.
export const NEVER_TRACKED_CHECK_INTERVAL_MS = parseInt(
  process.env.NEVER_TRACKED_CHECK_INTERVAL_MS || String(6 * 60 * 60 * 1000),
  10,
);
export const NEVER_TRACKED_TEST_MODE =
  process.env.NEVER_TRACKED_TEST_MODE === "true";
