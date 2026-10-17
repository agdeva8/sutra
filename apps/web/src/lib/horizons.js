/**
 * The plan's ladder, read straight off the board: month targets met by week targets met by day tasks.
 *
 * `state.plan_items` holds every rung as a row — `horizon: "monthly"` (the month's focus), `"weekly"`
 * (the week's focus, with `weekly_hours`) and `"daily"` (a task on a day, with its effort in `note`).
 * Today used to draw only the daily rung, so the targets above it were invisible. These helpers are
 * pure: they read `/state` and never fetch, and they follow `agenda.js` on dropped goals (a dropped
 * goal's plan is not rendered).
 */
import { blockDone, blockHours, isTodo } from "./events";
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

/**
 * The outcomes a week or month plan row carries, one per line in its `description` column. Blank
 * lines are noise the model sometimes leaves, so they are dropped rather than drawn as gaps.
 */
export function planOutcomes(item) {
  return String(item?.description || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
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

/** A task block as the plan row the target views draw, with its hours in `note` (see `itemHours`). */
function blockTaskRow(b) {
  const hours = blockHours(b);
  return {
    id: b.id,
    goal_id: b.goal_id,
    horizon: HORIZON_DAILY,
    title: b.title,
    description: b.description || "",
    status: blockDone(b) ? STATUS_DONE : "open",
    due_date: dayKey(b.day),
    note: hours ? `${hours}h` : "",
    state: b.state,
    done_fraction: b.done_fraction,
    // A part-done task is still open, but the fraction of its hours counts as done.
    done_hours: b.state === "partial" ? hours * (b.done_fraction || 0) : undefined,
  };
}

/**
 * The goal's daily tasks inside `item`'s dates, earliest first. To-dos are the user's own lists, not
 * the plan's work, so they are left out (the calendar still draws them beside the plan).
 *
 * The board now carries this work as `calendar_blocks` task rows too: a task the planner placed, or a
 * timed one under the goal. A block that mirrors a daily plan row (the backfill gave a task's first
 * session the task's own id) is counted once — the row is kept, and either side being done marks it
 * done.
 */
export function tasksInTarget(state, item) {
  const start = dayKey(item?.start_date);
  const end = dayKey(item?.end_date) || start;
  if (!start || !item?.goal_id) return [];
  const inside = (day) => !!day && day >= start && day <= end;
  const rows = (state?.plan_items || [])
    .filter((p) => {
      if (p.horizon !== HORIZON_DAILY || p.goal_id !== item.goal_id || isTodo(p)) return false;
      return inside(dayKey(p.due_date || p.start_date));
    })
    .slice();
  const byId = new Map(rows.map((p) => [p.id, p]));
  (state?.blocks || [])
    .filter(
      (b) =>
        b.block_kind === "task" &&
        b.goal_id === item.goal_id &&
        inside(dayKey(b.day)) &&
        (b.placed_by === "planner" || (b.start && b.end)),
    )
    .forEach((b) => {
      const twin = byId.get(b.id);
      if (twin) {
        const i = rows.indexOf(twin);
        if (blockDone(b) && twin.status !== STATUS_DONE) {
          // The block's own hours win when it has them; otherwise the plan row keeps its `note` hours.
          const hours = blockHours(b);
          rows[i] = { ...twin, status: STATUS_DONE, ...(hours ? { done_hours: hours } : {}) };
          byId.set(b.id, rows[i]);
        }
        return;
      }
      const row = blockTaskRow(b);
      rows.push(row);
      byId.set(b.id, row);
    });
  return rows.sort((a, b) => dayKey(a.due_date || a.start_date).localeCompare(dayKey(b.due_date || b.start_date)));
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
    if (p.status === STATUS_DONE) {
      done += 1;
      doneHours += typeof p.done_hours === "number" ? p.done_hours : hours;
      return;
    }
    // A part-done task counts its `done_fraction` of the hours, but not as a finished task.
    if (p.state === "partial") doneHours += hours * (p.done_fraction || 0);
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
