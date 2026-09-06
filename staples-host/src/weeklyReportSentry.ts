import { DISCORD_WEBHOOK_URL, WEEKLY_REPORT_CHECK_INTERVAL_MS } from "./config.js";
import { nzWeekdayAndHour } from "./nzTime.js";
import { daysSince, effectiveIntervalDays, todayIso } from "./replenishment.js";
import { withDb } from "./storage.js";
import type { Database, Item } from "./types.js";

export interface RunningOutItem {
  name: string;
  daysUntilDue: number; // <= 0 means already due/overdue
  replenishmentIntervalDays: number;
}

/**
 * Items projected to run out within 7 days -- reuses computeStatus's own
 * 2-event gate and effectiveIntervalDays exactly as list_staples/get_item
 * do, no new calculation. A single `daysUntilDue <= 7` rule subsumes
 * "already due" and "already overdue" (both land at daysUntilDue <= 0)
 * alongside "not due yet but will be within a week" -- see CLAUDE.md's
 * weekly restock report entry for why this deliberately inherits the
 * existing list_staples/get_item event-count-gate discrepancy rather than
 * introducing a third, differently-gated status derivation.
 */
export function itemsRunningOutSoon(db: Database): RunningOutItem[] {
  const results: RunningOutItem[] = [];

  for (const item of db.items) {
    if (item.replenishment_interval_days == null) continue;

    const events = db.purchase_events.filter((e) => e.item_id === item.item_id);
    if (events.length < 2) continue;

    if (!item.last_purchased) continue;

    const sorted = [...events].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const lastPurchaseQuantity = sorted[0]?.quantity ?? null;

    const effInterval = effectiveIntervalDays(item, lastPurchaseQuantity);
    if (effInterval == null) continue;

    const daysUntilDue = effInterval - daysSince(item.last_purchased);
    if (daysUntilDue <= 7) {
      results.push({ name: item.name, daysUntilDue, replenishmentIntervalDays: effInterval });
    }
  }

  return results.sort((a, b) => a.daysUntilDue - b.daysUntilDue);
}

function formatLine(item: RunningOutItem): string {
  const rate = `restock rate: every ~${item.replenishmentIntervalDays} days`;
  if (item.daysUntilDue <= 0) {
    const overdueBy = Math.abs(item.daysUntilDue);
    const overdueText = overdueBy === 0 ? "due today" : `overdue by ${overdueBy} day${overdueBy === 1 ? "" : "s"}`;
    return `- ${item.name} — ${overdueText} (${rate})`;
  }
  return `- ${item.name} — due in ${item.daysUntilDue} day${item.daysUntilDue === 1 ? "" : "s"} (${rate})`;
}

/**
 * Builds the weekly digest text -- always posts something, including a
 * positive "nothing due" message when the list is empty, so a week of
 * silence from this sentry is never ambiguous between "all stocked" and
 * "the job silently broke" (unlike the change-triggered auth-failure/
 * never-tracked sentries, this one runs on a fixed schedule regardless of
 * whether anything changed).
 */
export function formatWeeklyReport(items: RunningOutItem[]): string {
  if (items.length === 0) {
    return "📅 Weekly restock check — nothing due or running out in the next 7 days.";
  }

  const overdueOrDue = items.filter((i) => i.daysUntilDue <= 0);
  const runningOutSoon = items.filter((i) => i.daysUntilDue > 0);

  const sections: string[] = ["📅 Weekly restock check"];
  if (overdueOrDue.length > 0) {
    sections.push(["⚠️ Already due/overdue", ...overdueOrDue.map(formatLine)].join("\n"));
  }
  if (runningOutSoon.length > 0) {
    sections.push(["🔜 Running out within 7 days", ...runningOutSoon.map(formatLine)].join("\n"));
  }
  return sections.join("\n\n");
}

async function postToWebhook(content: string): Promise<void> {
  if (!DISCORD_WEBHOOK_URL) {
    console.warn("DISCORD_WEBHOOK_URL is not set -- weekly restock report computed but not posted.");
    return;
  }
  const res = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    throw new Error(`Discord webhook returned ${res.status}: ${await res.text().catch(() => "")}`);
  }
}

/**
 * Runs the check unconditionally (no schedule gate) -- used by the periodic
 * tick below, and directly testable/triggerable on its own. Only actually
 * posts + updates the dedup marker when called during the real Sunday-5pm
 * window via checkSchedule(); exported separately so the report-building
 * and posting logic can be exercised without waiting for real wall-clock
 * time to line up.
 */
export async function sendWeeklyReport(db: Database): Promise<string> {
  const items = itemsRunningOutSoon(db);
  const message = formatWeeklyReport(items);
  await postToWebhook(message);
  return message;
}

async function checkSchedule(): Promise<void> {
  const { weekday, hour } = nzWeekdayAndHour();
  if (weekday !== "Sunday" || hour !== 17) return;

  const today = todayIso();
  await withDb(async (db) => {
    if (db.lastWeeklyReportSentAt === today) return; // already sent this Sunday
    try {
      await sendWeeklyReport(db);
    } catch (err) {
      console.error("Weekly restock report failed to send", err);
      return; // don't mark as sent -- retry on the next tick within the same hour
    }
    db.lastWeeklyReportSentAt = today;
  });
}

export function startWeeklyReportSentry(): void {
  setInterval(() => {
    checkSchedule().catch((err) => console.error("Weekly restock report check failed", err));
  }, WEEKLY_REPORT_CHECK_INTERVAL_MS);
  console.log(`Weekly restock report sentry started (checking every ${WEEKLY_REPORT_CHECK_INTERVAL_MS}ms)`);
}
