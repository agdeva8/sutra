import { MIN_AWAKE_HOURS } from "../constants/profile";

/**
 * The "does this week make sense" check, run as the person fills the form so they are told at once, in plain
 * words, instead of after pressing Continue. It mirrors the server's own check (`waking_conflict` in
 * agentv2/core/profile.py), which stays the authority: this only saves a round trip.
 */
const DAY_MIN = 1440;
const toMin = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm || "");
  return m ? (Number(m[1]) * 60 + Number(m[2])) % DAY_MIN : null;
};
const mod = (n) => ((n % DAY_MIN) + DAY_MIN) % DAY_MIN;
const clock12 = (hhmm) => {
  const m = toMin(hhmm);
  const h = Math.floor(m / 60);
  return `${h % 12 || 12}:${String(m % 60).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};

/** A sentence saying what is wrong, or "" when the times agree with each other. */
export function weekProblem({ wake, sleep, workStart, workEnd }) {
  const w = toMin(wake);
  const s = toMin(sleep);
  if (w === null || s === null) return ""; // a skipped field is not a contradiction
  const awakeLen = mod(s - w) || DAY_MIN;
  const awake = `${clock12(wake)} to ${clock12(sleep)}`;
  const ws = toMin(workStart);
  const we = toMin(workEnd);
  if (ws !== null && we !== null && ws !== we) {
    // Work is inside the waking day when both its ends sit on the awake arc, in order.
    const so = mod(ws - w);
    const eo = mod(we - w);
    if (so > awakeLen || eo > awakeLen || so >= eo) {
      return `Your work hours (${clock12(workStart)} to ${clock12(workEnd)}) are outside the hours you're awake (${awake}). Check which is which.`;
    }
  }
  if (awakeLen < MIN_AWAKE_HOURS * 60) {
    return `That leaves you awake for only ${awakeLen / 60} hours (${awake}). Check your wake and sleep times.`;
  }
  return "";
}
