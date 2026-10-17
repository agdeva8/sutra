/**
 * The plan's ladder, read straight off the board: month targets met by week targets met by day tasks.
 *
 * `state.plan_items` holds every rung as a row — `horizon: "monthly"` (the month's focus), `"weekly"`
 * (the week's focus, with `weekly_hours`) and `"daily"` (a task on a day, with its effort in `note`).
 * Today used to draw only the daily rung, so the targets above it were invisible. These helpers are
 * pure: they read `/state` and never fetch, and they follow `agenda.js` on dropped goals (a dropped
 * goal's plan is not rendered).
 */
import { isTodo } from "./events";
import { localDateKey } from "./utils";

const HORIZON_MONTHLY = "monthly";
const HORIZON_WEEKLY = "weekly";
const HORIZON_DAILY = "daily";
const STATUS_DONE = "done";
const STATUS_DROPPED = "dropped";

/** A date field (`"2026-10-14"` or a `Date`) as a day key; null when absent. */
const dayKey = (v) => (v == null ? null : typeof v === "string" ? v.slice(0, 10) : localDateKey(v));

/** Hours a plan row holds: `weekly_hours` on a week row, or the "3h" in a month/day row's `note`. */
export function itemHours(item) {
  if (typeof item?.weekly_hours === "number") return item.weekly_hours;
  const m = /^\s*([\d.]+)\s*h\s*$/.exec(item?.note || "");
  return m ? Number(m[1]) : 0;
}

/** Whether `item`'s dates contain the day key. A row missing an end date covers its start day only. */
const covers = (item, key) => {
  const start = dayKey(item?.start_date);
  const end = dayKey(item?.end_date) || start;
  return !!start && key >= start && key <= end;
};

/** Targets at one rung, one per active goal, paired with the goal they belong to. */
function targetsAt(state, date, horizon) {
  const key = dayKey(date);
  const goals = new Map(
    (state?.goals || []).filter((g) => g.status !== STATUS_DROPPED).map((g) => [g.id, g]),
  );
  return (state?.plan_items || [])
    .filter((it) => it.horizon === horizon && it.goal_id && goals.has(it.goal_id) && covers(it, key))
    .map((item) => ({ goal: goals.get(item.goal_id), item }));
}

/**
 * This week's targets: for each active goal, the weekly item whose dates contain `date`, as
 * `[{ goal, item }]`. A goal planned without week rows simply has no entry.
 */
export const weekTargetsFor = (state, date) => targetsAt(state, date, HORIZON_WEEKLY);

/** This month's targets: the same for monthly items. */
export const monthTargetsFor = (state, date) => targetsAt(state, date, HORIZON_MONTHLY);

/**
 * The goal's daily tasks inside `item`'s dates, earliest first. To-dos are the user's own lists, not
 * the plan's work, so they are left out (the calendar still draws them beside the plan).
 */
export function tasksInTarget(state, item) {
  const start = dayKey(item?.start_date);
  const end = dayKey(item?.end_date) || start;
  if (!start || !item?.goal_id) return [];
  return (state?.plan_items || [])
    .filter((p) => {
      if (p.horizon !== HORIZON_DAILY || p.goal_id !== item.goal_id || isTodo(p)) return false;
      const day = dayKey(p.due_date || p.start_date);
      return !!day && day >= start && day <= end;
    })
    .sort((a, b) => dayKey(a.due_date || a.start_date).localeCompare(dayKey(b.due_date || b.start_date)));
}

/**
 * Where a target stands: its daily tasks done and total, plus done and planned hours where the rows
 * carry any (`done_hours` is set when a task was only partly done).
 */
export function targetProgress(state, item) {
  const tasks = tasksInTarget(state, item);
  let done = 0;
  let doneHours = 0;
  let plannedHours = 0;
  tasks.forEach((p) => {
    const hours = itemHours(p);
    plannedHours += hours;
    if (p.status !== STATUS_DONE) return;
    done += 1;
    doneHours += typeof p.done_hours === "number" ? p.done_hours : hours;
  });
  return { done, total: tasks.length, doneHours, plannedHours, hasHours: plannedHours > 0 };
}

/**
 * The week targets under a month target, earliest first — the ladder from month down to week. The
 * weeks are the goal's own weekly rows that overlap the month, so a Monday that falls just before
 * the 1st still appears under the month it mostly belongs to.
 */
export function weekTargetsInMonth(state, monthItem) {
  const start = dayKey(monthItem?.start_date);
  const end = dayKey(monthItem?.end_date) || start;
  if (!start || !monthItem?.goal_id) return [];
  return (state?.plan_items || [])
    .filter((p) => p.horizon === HORIZON_WEEKLY && p.goal_id === monthItem.goal_id)
    .filter((p) => {
      const s = dayKey(p.start_date);
      const e = dayKey(p.end_date) || s;
      return !!s && s <= end && e >= start;
    })
    .sort((a, b) => dayKey(a.start_date).localeCompare(dayKey(b.start_date)));
}
