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

/**
 * Error text that means "Woolworths is broken right now", not "this
 * session has expired".
 *
 * Confirmed live: a real 502 from Woolworths' own nginx (HTML body,
 * `<title>502 Bad Gateway</title>`, nginx footer) reached this sentry as a
 * tool-level error and was reported to the channel as "Woolworths session
 * is dead", prompting a pointless re-login for a session that was fine --
 * it recovered on its own five hours later with no intervention. An
 * upstream 5xx says nothing whatsoever about the cookie.
 *
 * Deliberately a narrow allowlist of *known* transient shapes rather than
 * the reverse (an allowlist of known auth shapes): anything unrecognized
 * still alerts. That preserves the reason the isError branch exists at all
 * -- a genuinely dead session arrives as a plain-text GraphQL error, and an
 * earlier version silently swallowed exactly that case. Getting an extra
 * alert for an unfamiliar error is recoverable; missing a real expiry is
 * the failure that actually costs something.
 */
const UPSTREAM_FAILURE_PATTERNS: RegExp[] = [
  /\bHTTP\s+5\d\d\b/i,
  /\bbad\s+gateway\b/i,
  /\bservice\s+unavailable\b/i,
  /\bgateway\s+time-?out\b/i,
  /\binternal\s+server\s+error\b/i,
  /\bETIMEDOUT\b/i,
  /\bECONNRESET\b/i,
  /\bECONNREFUSED\b/i,
];

/** Exported for the sentry's own check script; not used elsewhere. */
export function isUpstreamFailure(text: string): boolean {
  return UPSTREAM_FAILURE_PATTERNS.some((re) => re.test(text));
}

async function checkOnce(): Promise<void> {
  let status: AuthStatusResult | null = null;
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
    let errorText: string | null = null;
    if (result.isError) {
      errorText = toolResultText(result) || "auth_status call returned an error";
    } else {
      try {
        status = toolResultJson<AuthStatusResult>(result);
      } catch (parseErr) {
        errorText = `auth_status returned an unparseable response: ${toolResultText(result)}`;
      }
    }

    if (errorText !== null) {
      // An upstream 5xx is the same category as the "fetch failed" case in
      // the catch below -- Woolworths being unreachable or broken, which
      // this sentry has never alerted on and shouldn't start alerting on
      // now. Logged (so a sustained outage is still visible here) but not
      // posted to the channel, and crucially the saved state is left
      // untouched: an outage must not flip lastKnownUsable, or the eventual
      // recovery would be logged as a session recovery that never happened.
      if (isUpstreamFailure(errorText)) {
        logger.error("auth_status hit an upstream failure -- not an auth problem, not alerting", {
          hint: errorText.slice(0, 200),
        });
        return;
      }
      status = { accountToolsUsable: false, hint: errorText };
    }
  } catch (err) {
    // A genuine connection/protocol failure (e.g. "fetch failed") -- still
    // logged and skipped, not alerted on, same as before: this is the
    // transient-network-blip shape, distinct from an auth failure.
    logger.error("auth_status check failed", { err: String(err) });
    return;
  }

  if (status === null) {
    // Unreachable: every path above either assigns status or returns.
    logger.error("auth_status produced no status -- skipping");
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
