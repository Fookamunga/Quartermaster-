import path from "node:path";
import {
  DATA_DIR,
  NEVER_TRACKED_CHECK_INTERVAL_MS,
  NEVER_TRACKED_TEST_MODE,
  STAPLES_HOST_URL,
} from "./config.js";
import { sendChannelMessage } from "./discord.js";
import { loadJson, saveJson } from "./jsonStore.js";
import { logger } from "./logger.js";
import { callTool, toolResultJson } from "./mcpClient.js";

const STATE_FILE = path.join(DATA_DIR, "never-tracked-state.json");

interface StapleSummary {
  name: string;
  status: "not_due" | "due" | "overdue";
  last_purchased: string | null;
  replenishment_interval_days: number | null;
  interval_confidence: "seeded" | "learned";
}

interface SentryState {
  lastPostedNames: string[];
}

function loadState(): SentryState {
  return loadJson<SentryState>(STATE_FILE, { lastPostedNames: [] });
}

function saveState(state: SentryState): void {
  saveJson(STATE_FILE, state);
}

/**
 * Items with an interval (seeded or learned) but no last_purchased anchor --
 * exactly the Craft doc's "❔ Never tracked" category, never "❔ Not enough
 * data yet" (no interval at all). Checks replenishment_interval_days != null
 * explicitly rather than trusting status alone, so this stays correct even
 * if status's derivation changes elsewhere -- no-interval items must never
 * trigger a Discord alert under any sentry. See CLAUDE.md.
 */
export function filterNeverTracked(items: StapleSummary[]): StapleSummary[] {
  return items.filter(
    (item) => item.replenishment_interval_days != null && !item.last_purchased,
  );
}

function sameNameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((name, i) => name === sortedB[i]);
}

export async function checkOnce(): Promise<void> {
  let items: StapleSummary[];
  try {
    const result = await callTool("discordbot-never-tracked", STAPLES_HOST_URL, "list_staples", {});
    const data = toolResultJson<{ items: StapleSummary[] }>(result);
    items = data.items;
  } catch (err) {
    logger.error("list_staples check failed", { err: String(err) });
    return;
  }

  const neverTracked = filterNeverTracked(items);
  const names = neverTracked.map((i) => i.name).sort();

  const state = loadState();
  if (sameNameSet(names, state.lastPostedNames)) {
    logger.info("Never-tracked set unchanged, skipping post", { count: names.length });
    return;
  }

  if (names.length === 0) {
    // Set went from non-empty to empty -- update state quietly, no need to
    // post "nothing to report" as its own alert.
    saveState({ lastPostedNames: [] });
    return;
  }

  const lines = neverTracked
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((item) => `- ${item.name} — no purchase on record yet (usually every ~${item.replenishment_interval_days} days)`);
  const message = [`❔ Never tracked`, ...lines].join("\n");

  await sendChannelMessage("woolworths-ordering", message).catch((err) =>
    logger.error("Failed to send Never-tracked alert", { err: String(err) }),
  );
  saveState({ lastPostedNames: names });
}

export function startNeverTrackedSentry(): void {
  if (NEVER_TRACKED_TEST_MODE) {
    logger.info("NEVER_TRACKED_TEST_MODE=true: running an immediate check on startup");
    checkOnce().catch((err) => logger.error("Never-tracked test-mode check failed", { err: String(err) }));
  }
  setInterval(() => {
    checkOnce().catch((err) => logger.error("Never-tracked check failed", { err: String(err) }));
  }, NEVER_TRACKED_CHECK_INTERVAL_MS);
  logger.info("Never-tracked sentry started", { intervalMs: NEVER_TRACKED_CHECK_INTERVAL_MS });
}
