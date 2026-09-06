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
