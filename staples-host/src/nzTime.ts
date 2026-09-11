// Same reasoning as replenishment.ts's todayIso() and discordbot-host's own
// nzTime.ts: this process almost certainly runs in UTC regardless of the
// household's real timezone, so any "is it Sunday 5pm" check must read NZ
// wall-clock time explicitly rather than the container's own local time.
// Hardcoded to Pacific/Auckland for the same reason those do -- correct
// regardless of container/OS config, can't silently regress on a future
// redeploy that forgets to set TZ.
const NZ_WEEKDAY_HOUR_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "Pacific/Auckland",
  weekday: "long",
  hour: "2-digit",
  hourCycle: "h23", // guarantees "00"-"23", avoiding ICU's midnight-as-"24" quirk under hour12:false
});

export interface NzWeekdayHour {
  weekday: "Sunday" | "Monday" | "Tuesday" | "Wednesday" | "Thursday" | "Friday" | "Saturday";
  hour: number; // 0-23, NZ local
}

export function nzWeekdayAndHour(): NzWeekdayHour {
  const parts = NZ_WEEKDAY_HOUR_FORMATTER.formatToParts(new Date());
  const weekday = parts.find((p) => p.type === "weekday")?.value as NzWeekdayHour["weekday"];
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  return { weekday, hour };
}

const NZ_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Pacific/Auckland",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * Converts an arbitrary ISO datetime (e.g. woolies-mcp's UTC `placedAt`) to
 * its NZ-local calendar date -- same reasoning as replenishment.ts's own
 * todayIso(): a naive slice(0, 10) on a UTC timestamp gets the wrong date for
 * roughly half of every NZ calendar day (NZ is UTC+12/+13). Used by
 * purchaseHistorySync.ts to record each synced order's purchase_event under
 * the date it was actually placed in NZ, not the UTC date the API stamps it
 * with.
 */
export function nzDateFromIso(isoDatetime: string): string {
  return NZ_DATE_FORMATTER.format(new Date(isoDatetime));
}
