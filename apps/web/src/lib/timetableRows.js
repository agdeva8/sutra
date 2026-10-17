/**
 * The 4-kind calendar blocks, in the old timetable row shape the Timeline's card builders read.
 *
 *   old row: { id, block_date, start_time, end_time, label, kind, source?, source_id?, goal_id?, why? }
 *   4-kind:  { id, block_kind, title, day, start, end, at, repeat, placed_by, ... }
 *
 * The adapter sits where the data enters the screen, so `blockCards`, `sessionCards`, `reminderCards`
 * and `handleBlockDrop` keep reading one shape regardless of which model the board sent. Pure: no DB,
 * network or React.
 */
import { parseDateKey } from "./istTime";
import { isFourKindBlock, repeatDays } from "./events";
import { SOURCE_RECURRING } from "../constants/calendarKinds";

const BLOCK_KIND_EVENT = "event";
const BLOCK_KIND_TASK = "task";
const PLACED_BY_PLANNER = "planner";
const STATUS_DONE = "done";
/** Separates a repeating row's own id from the day of an occurrence ("<id>:<YYYY-MM-DD>"). */
const OCCURRENCE_SEP = ":";
const DAY_MS = 86400000;

const dayKey = (v) => (v == null || v === "" ? null : String(v).slice(0, 10));

/** A Date or "YYYY-MM-DD" → that day at local midnight, or null. */
function toDay(value) {
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return null;
    const d = new Date(value);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  return parseDateKey(value);
}

const isoDay = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Every day key from `from` to `to`, inclusive. */
function dayKeysBetween(from, to) {
  const start = toDay(from);
  const end = toDay(to);
  if (!start || !end || end < start) return [];
  const keys = [];
  for (let d = start; d <= end; d = new Date(d.getTime() + DAY_MS)) keys.push(isoDay(d));
  return keys;
}

/**
 * The days a block belongs on. A repeat expands over `keys`; a one-off is its own `day`. With no range
 * supplied, a repeat falls back to its own day so it still draws once instead of vanishing.
 */
function occurrenceDays(b, keys) {
  if (keys.length) return repeatDays(b, keys);
  const own = dayKey(b.day);
  return own ? [own] : [];
}

/** One event row (a commitment) on `day`. No start means an all-day marker, not midnight. */
function eventRow(b, day) {
  return {
    id: b.id,
    block_date: day,
    start_time: b.start ?? null,
    end_time: b.end ?? null,
    label: b.title,
    goal_id: b.goal_id ?? null,
    why: b.note ?? "",
    kind: "committed",
  };
}

/** One timed task row. A planner-placed session is tentative; the user's own time is committed. */
function taskRow(b, day) {
  return {
    id: b.id,
    block_date: day,
    start_time: b.start,
    end_time: b.end,
    label: b.title,
    kind: b.placed_by === PLACED_BY_PLANNER ? "tentative" : "committed",
    // The block *is* the task, so its own id is the task it was set aside for.
    source_id: b.id,
    goal_id: b.goal_id ?? null,
    why: b.why ?? "",
  };
}

/**
 * One untimed task the planner placed on a day — a quota or a multi-day item. It has no clock
 * times, so it draws as an all-day row; a quota says its per-day count in the label.
 */
function allDayTaskRow(b, day) {
  return {
    id: b.id,
    block_date: day,
    start_time: null,
    end_time: null,
    label: b.quota ? `${b.title} · ${b.quota}/day` : b.title,
    kind: b.placed_by === PLACED_BY_PLANNER ? "tentative" : "committed",
    source_id: b.id,
    goal_id: b.goal_id ?? null,
    why: b.why ?? "",
  };
}

/** An untimed task the planner placed on a day (a quota or a multi-day item), never an `at` reminder. */
const isUntimedPlannerTask = (b) =>
  b.block_kind === BLOCK_KIND_TASK &&
  !b.at &&
  !b.start &&
  !b.end &&
  !!dayKey(b.day) &&
  b.placed_by === PLACED_BY_PLANNER;

/** Every occurrence of a repeating row, each carrying its own id and the series it came from. */
function rowsFor(b, keys, rowFor) {
  return occurrenceDays(b, keys).map((day) => {
    const row = rowFor(b, day);
    if (!b.repeat) return row;
    return {
      ...row,
      id: `${b.id}${OCCURRENCE_SEP}${day}`,
      block_date: day,
      source: SOURCE_RECURRING,
      source_id: b.id,
    };
  });
}

/**
 * 4-kind `calendar_blocks` → old-shape timetable rows.
 *
 * Events are commitments (a repeat becomes one row per occurrence). A task with both `start` and `end`
 * is a timed block; a task with only `at` is a reminder (see `toReminderRows`), a task with no time is
 * on the day's task list, and away / milestone rows are not timetable rows at all. A row that is
 * already in the old shape passes through untouched.
 */
export function toTimetableRows(blocks, { from, to } = {}) {
  const keys = dayKeysBetween(from, to);
  const rows = [];
  (blocks || []).forEach((b) => {
    if (!isFourKindBlock(b)) {
      rows.push(b);
      return;
    }
    if (b.block_kind === BLOCK_KIND_EVENT) {
      rows.push(...rowsFor(b, keys, eventRow));
      return;
    }
    if (b.block_kind === BLOCK_KIND_TASK && !b.at) {
      if (b.start && b.end) rows.push(...rowsFor(b, keys, taskRow));
      else if (isUntimedPlannerTask(b)) rows.push(...rowsFor(b, keys, allDayTaskRow));
    }
  });
  return rows;
}

/**
 * 4-kind task rows with an `at` → old-shape reminder rows (`{ days, times }`), which is what
 * `reminderCards` reads. A repeat becomes every occurrence's day; a one-off is its own `day`.
 */
export function toReminderRows(reminders, { from, to } = {}) {
  const keys = dayKeysBetween(from, to);
  const rows = [];
  (reminders || []).forEach((r) => {
    if (!isFourKindBlock(r)) {
      rows.push(r);
      return;
    }
    if (r.block_kind !== BLOCK_KIND_TASK || !r.at) return;
    rows.push({
      id: r.id,
      title: r.title,
      goal_id: r.goal_id ?? null,
      days: occurrenceDays(r, keys),
      times: [r.at],
    });
  });
  return rows;
}

/** A 4-kind milestone says `reached`; an old row says `status`. Both mean done. */
export const isMilestoneDone = (m) => m?.reached === true || m?.status === STATUS_DONE;
