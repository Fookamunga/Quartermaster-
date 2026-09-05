// The household is in NZ, but this process's own container almost
// certainly isn't -- confirmed live on the NAS: both discordbot-host and
// staples-host run in UTC (no TZ set, the standard minimal-base-image
// default). A bare `new Date().toISOString()` handed to the agent is
// technically UTC-marked ("Z" suffix), but nothing tells the agent this
// household is 12-13 hours ahead, so date-arithmetic reasoning ("today",
// "tomorrow", "this weekend") risks landing on the wrong NZ calendar day
// for roughly half of each day. Hardcoded to Pacific/Auckland rather than
// reading TZ from the environment, matching staples-host's todayIso() fix
// -- correct regardless of container/OS config, can't silently regress if
// a future redeploy forgets to set TZ.
const NZ_TIMESTAMP_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Pacific/Auckland",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZoneName: "short",
});

/** e.g. "2026-09-06, 11:23:00 GMT+12" -- explicit offset, not an ambiguous abbreviation. */
export function nzTimestamp(): string {
  return NZ_TIMESTAMP_FORMATTER.format(new Date());
}
