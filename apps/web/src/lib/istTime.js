/**
 * IST wall-clock helpers.
 *
 * IST is the app's only time zone for now: `USE_CLIENT_TIMEZONE=False`, so every
 * user is on `DEFAULT_TIMEZONE` (Asia/Kolkata) until that is flipped (CLAUDE.md).
 * The API therefore speaks IST wall-clock values — a date is "YYYY-MM-DD" and a
 * time is "HH:MM", with no zone attached — and the UI must show them exactly as
 * they arrive.
 *
 * A browser, meanwhile, hands back `new Date()` in the *device's* zone. A phone
 * on UTC at 01:00 IST is still on yesterday's calendar date, so "today", "now"
 * and every device-local getter can be a day (or half a day) off. Parsing a
 * date-only string with `new Date("2026-10-17")` is worse still: it is read as
 * UTC midnight, which in IST is 05:30 and in zones west of UTC is the previous
 * evening.
 *
 * So there is exactly one place that answers "what date/time is it in IST", and
 * exactly one way to turn an API value into a `Date`: build the fields locally,
 * never through UTC. The Dates returned here carry IST's wall-clock in their
 * local fields, so plain `getHours()` / `getDate()` / `setHours()` (and the
 * calendar grid, which builds its cells the same way) all agree.
 */

export const IST_TIME_ZONE = "Asia/Kolkata";

/** Formats an instant in IST, one field per part, regardless of the device zone. */
const IST_PARTS_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: IST_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

const pad2 = (n) => String(n).padStart(2, "0");

/** The IST calendar fields of an instant. */
function istParts(date = new Date()) {
  const parts = {};
  for (const { type, value } of IST_PARTS_FORMATTER.formatToParts(date)) {
    parts[type] = value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/**
 * "Now" in IST, as a Date whose *local* getters read IST's wall clock.
 *
 * Built field by field from the IST formatter rather than by adding the offset
 * to the instant: adding offset minutes only lands on the right wall clock when
 * the device itself runs on UTC.
 */
export function istNow(date = new Date()) {
  const { year, month, day, hour, minute, second } = istParts(date);
  return new Date(year, month - 1, day, hour, minute, second);
}

/** The IST calendar date of an instant (default: now) as "YYYY-MM-DD". */
export function istDateKey(date = new Date()) {
  const { year, month, day } = istParts(date);
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** Today's IST date as "YYYY-MM-DD". */
export function istTodayKey(date = new Date()) {
  return istDateKey(date);
}

/** Minutes since IST midnight for an instant (0–1439). */
export function istMinutesOfDay(date = new Date()) {
  const { hour, minute } = istParts(date);
  return hour * 60 + minute;
}

const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})/;
const TIME_ONLY_RE = /^(\d{1,2}):(\d{2})(?::\d{2})?$/;
/** A trailing "Z" or ±hh:mm means the value is an instant, not IST wall clock. */
const ZONE_SUFFIX_RE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * "YYYY-MM-DD" (or any string starting with it) → local midnight on that date.
 *
 * Uses `new Date(y, m - 1, d)`, which keeps the date exactly as written. The
 * `new Date("YYYY-MM-DD")` form must never be used for this: it is parsed as
 * UTC midnight and shifts the day for every zone whose offset is not zero.
 */
export function parseDateKey(value) {
  if (value == null || value === "") return null;
  const m = DATE_KEY_RE.exec(String(value).trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d.getTime()) ? null : d;
}

/** "HH:MM" (optionally ":SS") → `{ hours, minutes }`, or null when it is not a clock time. */
export function parseClockTime(value) {
  if (value == null) return null;
  const m = TIME_ONLY_RE.exec(String(value).trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  return { hours, minutes };
}

/**
 * A date key plus a clock time → a Date at that IST wall clock.
 *
 *     parseWallClockAt("2026-10-17", "14:30").getHours() === 14
 *
 * regardless of the device's zone. Returns null when either half is missing or
 * malformed — an untimed item must stay untimed, not become 00:00.
 */
export function parseWallClockAt(dateKey, time) {
  const day = parseDateKey(dateKey);
  const clock = parseClockTime(time);
  if (!day || !clock) return null;
  day.setHours(clock.hours, clock.minutes, 0, 0);
  return day;
}

/**
 * An API timestamp → a Date carrying its IST wall clock.
 *
 * A value without a zone ("2026-10-17", "2026-10-17T09:00:00", "2026-10-17 09:00")
 * is already IST wall clock and is read field by field. A value *with* a zone
 * ("…Z", "…+05:30") is a real instant, so it is shifted into IST first.
 */
export function parseWallClock(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : new Date(value.getTime());
  const text = String(value).trim();
  if (ZONE_SUFFIX_RE.test(text)) {
    const instant = new Date(text);
    return isNaN(instant.getTime()) ? null : istNow(instant);
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(text);
  if (!m) return null;
  const d = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4] || 0),
    Number(m[5] || 0),
    Number(m[6] || 0),
  );
  return isNaN(d.getTime()) ? null : d;
}
