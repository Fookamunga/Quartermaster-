import path from "node:path";
import { AUTH_ALERT_REPEAT_MS, AUTH_CHECK_INTERVAL_MS, DATA_DIR, WOOLIES_MCP_URL } from "./config.js";
import { sendChannelMessage } from "./discord.js";
import { loadJson, saveJson } from "./jsonStore.js";
import { logger } from "./logger.js";
import { callTool, toolResultJson, toolResultText } from "./mcpClient.js";

const STATE_FILE = path.join(DATA_DIR, "woolies-health-state.json");

interface AuthStatusResult {
  accountToolsUsable: boolean;
  cookieExpiresAt?: string;
  hint: string;
}

interface SentryState {
  lastKnownUsable: boolean;
  lastAlertAt: string | null;
}

function loadState(): SentryState {
  return loadJson<SentryState>(STATE_FILE, { lastKnownUsable: true, lastAlertAt: null });
}

function saveState(state: SentryState): void {
  saveJson(STATE_FILE, state);
}

async function checkOnce(): Promise<void> {
  let status: AuthStatusResult;
  try {
    const result = await callTool("discordbot-woolies-health", WOOLIES_MCP_URL, "auth_status", {});
    // A dead Woolworths session surfaces as a tool-level error (isError:
    // true, plain-text GraphQL message like "...AUTH_NOT_AUTHENTICATED"),
    // not as a well-formed { accountToolsUsable: false, ... } JSON body --
    // confirmed live against the real account. Parsing that text as JSON
    // (the previous behavior) throws a SyntaxError that landed in the catch
    // below, which silently logged and returned -- this is exactly the
    // "auth expired" case the alert exists for, and it was being treated
    // identically to a transient network hiccup. Handle it explicitly as a
    // real auth failure instead of letting JSON.parse crash it.
    if (result.isError) {
      status = {
        accountToolsUsable: false,
        hint: toolResultText(result) || "auth_status call returned an error",
      };
    } else {
      try {
        status = toolResultJson<AuthStatusResult>(result);
      } catch (parseErr) {
        status = {
          accountToolsUsable: false,
          hint: `auth_status returned an unparseable response: ${toolResultText(result)}`,
        };
      }
    }
  } catch (err) {
    // A genuine connection/protocol failure (e.g. "fetch failed") -- still
    // logged and skipped, not alerted on, same as before: this is the
    // transient-network-blip shape, distinct from an auth failure.
    logger.error("auth_status check failed", { err: String(err) });
    return;
  }

  const state = loadState();
  const now = new Date();

  if (status.accountToolsUsable) {
    if (!state.lastKnownUsable) {
      logger.info("Woolworths session recovered");
    }
    saveState({ lastKnownUsable: true, lastAlertAt: null });
    return;
  }

  // Alert on the true -> false transition, then repeat at most once per
  // AUTH_ALERT_REPEAT_MS while it stays down -- never every poll. See
  // CLAUDE.md's discordbot-host "Woolworths auth-failure alerting" section.
  const justWentDown = state.lastKnownUsable;
  const dueForRepeat =
    !justWentDown &&
    state.lastAlertAt !== null &&
    now.getTime() - new Date(state.lastAlertAt).getTime() >= AUTH_ALERT_REPEAT_MS;

  if (justWentDown || dueForRepeat) {
    logger.warn("Woolworths session is dead", { hint: status.hint });
    await sendChannelMessage(
      "woolworths-ordering",
      `Woolworths session is dead. Fix it from your PC: npm run login -- --server ${WOOLIES_MCP_URL}`,
    ).catch((err) => logger.error("Failed to send auth-failure alert", { err: String(err) }));
    saveState({ lastKnownUsable: false, lastAlertAt: now.toISOString() });
  } else {
    saveState({ lastKnownUsable: false, lastAlertAt: state.lastAlertAt });
  }
}

export function startWooliesHealthSentry(): void {
  checkOnce().catch((err) => logger.error("Initial auth_status check failed", { err: String(err) }));
  setInterval(() => {
    checkOnce().catch((err) => logger.error("auth_status check failed", { err: String(err) }));
  }, AUTH_CHECK_INTERVAL_MS);
  logger.info("Woolworths auth-failure sentry started", { intervalMs: AUTH_CHECK_INTERVAL_MS });
}
