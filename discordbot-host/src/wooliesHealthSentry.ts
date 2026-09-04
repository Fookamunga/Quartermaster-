import path from "node:path";
import { AUTH_ALERT_REPEAT_MS, AUTH_CHECK_INTERVAL_MS, DATA_DIR, WOOLIES_MCP_URL } from "./config.js";
import { sendChannelMessage } from "./discord.js";
import { loadJson, saveJson } from "./jsonStore.js";
import { logger } from "./logger.js";
import { callTool, toolResultJson } from "./mcpClient.js";

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
    status = toolResultJson<AuthStatusResult>(result);
  } catch (err) {
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
