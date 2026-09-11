import { PURCHASE_HISTORY_SYNC_CHECK_INTERVAL_MS, PURCHASE_HISTORY_SYNC_TEST_MODE } from "./config.js";
import { nzWeekdayAndHour } from "./nzTime.js";
import { syncPurchaseHistory } from "./purchaseHistorySync.js";
import { todayIso } from "./replenishment.js";
import { withDb } from "./storage.js";

/**
 * staples-host's own scheduled purchase-history sync -- runs entirely inside
 * this process (started from index.ts's app.listen, same as
 * weeklyReportSentry.ts), independent of discordbot-host and Discord. Per
 * the standing architecture rule -- Discord is a disposable front end, core
 * domain logic must never live inside or depend on it -- this must complete
 * successfully on its own schedule whether or not Discord's bot token/API is
 * configured, reachable, or even present.
 *
 * Deliberately shares no function calls with weeklyReportSentry.ts, in
 * either direction -- the two are coupled only by clock time, not by one
 * triggering the other. Scheduled for Sunday 16:00 NZ, one hour before that
 * file's own 17:00 NZ report window, specifically so the weekly restock
 * digest reflects freshly-synced purchase history without the files
 * importing from each other. If this sync fails, or Discord itself is down
 * that week, the weekly report still runs on its own independent schedule
 * against whatever data already exists -- a stale report is a separate,
 * acceptable failure mode from "the sync didn't run" (see CLAUDE.md).
 */
const SYNC_WEEKDAY = "Sunday";
const SYNC_HOUR = 16;

/**
 * Runs the sync unconditionally (no schedule gate) -- used by the periodic
 * tick below and by PURCHASE_HISTORY_SYNC_TEST_MODE's immediate startup run,
 * same "exported separately so it's directly testable/triggerable" pattern
 * as weeklyReportSentry.ts's sendWeeklyReport.
 */
async function runScheduledSync(): Promise<void> {
  const today = todayIso();
  await withDb(async (db) => {
    if (db.lastPurchaseHistoryScheduledSyncDate === today) return; // already ran today

    const result = await syncPurchaseHistory(db);
    if (!result.ok) {
      console.error(
        "Scheduled purchase-history sync failed:",
        result.error ?? (result.authFailure ? "Woolworths auth is not usable" : "unknown error"),
      );
      return; // don't mark as run -- retry on the next tick within the same hour
    }

    db.lastPurchaseHistoryScheduledSyncDate = today;
    console.log(
      `Purchase-history sync: ${result.ordersProcessed} new order(s) processed ` +
        `(${result.matched} matched, ${result.alreadyRecorded} already recorded, ` +
        `${result.unmatched.length} unmatched line(s)); ${result.ordersSkippedAlreadySynced} already up to date.`,
    );
  });
}

async function checkSchedule(): Promise<void> {
  const { weekday, hour } = nzWeekdayAndHour();
  if (weekday !== SYNC_WEEKDAY || hour !== SYNC_HOUR) return;
  await runScheduledSync();
}

export function startPurchaseHistorySyncSentry(): void {
  if (PURCHASE_HISTORY_SYNC_TEST_MODE) {
    runScheduledSync().catch((err) => console.error("Purchase-history sync test-mode run failed", err));
  }
  setInterval(() => {
    checkSchedule().catch((err) => console.error("Purchase-history sync schedule check failed", err));
  }, PURCHASE_HISTORY_SYNC_CHECK_INTERVAL_MS);
  console.log(
    `Purchase-history sync sentry started (checking every ${PURCHASE_HISTORY_SYNC_CHECK_INTERVAL_MS}ms)`,
  );
}
