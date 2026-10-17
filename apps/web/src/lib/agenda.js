/**
 * The agenda: every Event (lib/events.js) that falls on a run of days, grouped by day, so the Today tab can
 * list a day, a week or a month without each view re-deriving it. Pure: it reads the board `/state` already
 * returns and never fetches.
 *
 * Done things stay: a ticked to-do or task is listed on its day, struck through and sunk below what is
 * still open. Only an open item past its day is carried onto today (overdue); a done undated to-do stays on
 * the day it was ticked.
 */
import { localDateKey } from "./utils";
import { EVENT_KIND, awayEvents, blockEvent, blockEvents, blockHours, isTodo, milestoneEvent, planItemEvent, reminderEvents } from "./events";

const DAY_MS = 86400000;
const HORIZON_DAILY = "daily";
const STATUS_DONE = "done";

/** Order inside a day, after done-ness: all-day kinds first in this order, then timed ones by clock. */
const ALL_DAY_ORDER = { away: 0, milestone: 1, todo: 2, task: 3 };
const UNRANKED = 9;

const parseKey = (k) => new Date(`${String(k).slice(0, 10)}T00:00:00`);

/** Day keys from `from` for `count` days. */
export function dayKeys(from, count) {
  const start = parseKey(localDateKey(from));
  return Array.from({ length: count }, (_, i) => localDateKey(new Date(start.getTime() + i * DAY_MS)));
}

/** Open before done; then all-day before timed; then clock time; overdue open work first. */
export function compareEvents(a, b) {
  if (a.done !== b.done) return a.done ? 1 : -1;
  if (a.time && b.time) return a.time.localeCompare(b.time);
  if (a.time || b.time) return a.time ? 1 : -1;
  return (ALL_DAY_ORDER[a.kind] ?? UNRANKED) - (ALL_DAY_ORDER[b.kind] ?? UNRANKED) || (b.overdue ? 1 : 0) - (a.overdue ? 1 : 0);
}

/**
 * Events per day for the days in `keys` (ISO strings). An undated open to-do sits on today; an undated
 * done one sits only on the day it was ticked (`done_at`), struck through, and is not carried forward.
 * One ticked a moment ago, before the board reloads with its `done_at`, counts as ticked today.
 */
export function buildAgenda(state, keys, today = new Date()) {
  const todayKey = localDateKey(today);
  const inRange = new Set(keys);
  const byDay = Object.fromEntries(keys.map((k) => [k, []]));
  const push = (e) => e.day && inRange.has(e.day) && byDay[e.day].push(e);
  const goals = new Map((state?.goals || []).map((g) => [g.id, g]));
  const live = (goalId) => !goalId || goals.get(goalId)?.status !== "dropped";
  const title = (goalId) => goals.get(goalId)?.title || "";
  const planItems = state?.plan_items || [];
  const taskById = new Map(planItems.map((p) => [p.id, p]));
  // The 4-kind board. Its task blocks are what `plan_items` used to carry, so a plan row whose id
  // matches a block (the backfill copied a task's first session with the task's own id) is not listed
  // twice — the block stands for it, and the row's tick marks the block done.
  const blocks = Array.isArray(state?.blocks) ? state.blocks : null;
  const blockTaskIds = new Set(
    (blocks || []).filter((b) => b.block_kind === "task").map((b) => b.id),
  );
  // A task already drawn as a timed session is not listed again as a loose task on the same day.
  const inSession = new Set();

  if (blocks) {
    blocks.forEach((b) => {
      if (b.goal_id && !live(b.goal_id)) return;
      const twinDone = taskById.get(b.id)?.status === STATUS_DONE;
      blockEvents(b, keys, { goalTitle: title(b.goal_id), todayKey }).forEach((e) => {
        if (twinDone && !e.done) {
          e.done = true;
          if (e.task) e.task = { ...e.task, status: STATUS_DONE };
        }
        push(e);
      });
    });
  } else {
    // A board older than `blocks`: read the legacy sources as before.
    (state?.timetable_blocks || state?.timetableBlocks || []).forEach((b) => {
      if (!live(b.goal_id)) return;
      const e = blockEvent(b, { taskById, goalTitle: title(b.goal_id) });
      if (e.task) inSession.add(`${e.day}:${e.task.id}`);
      push(e);
    });
    (state?.reminders || []).forEach((r) => reminderEvents(r, title(r.goal_id)).forEach(push));
    (state?.milestones || []).forEach((m) => live(m.goal_id) && push(milestoneEvent(m, title(m.goal_id))));
    (state?.blockers || []).forEach((b) => awayEvents(b, keys).forEach(push));
  }
  planItems.forEach((p) => {
    if (blockTaskIds.has(p.id)) return;
    if (p.horizon !== HORIZON_DAILY || !live(p.goal_id)) return;
    const e = planItemEvent(p, title(p.goal_id));
    if (!e.day && e.done && isTodo(p)) e.day = p.done_at ? localDateKey(new Date(p.done_at)) : todayKey;
    else if (!e.day && (isTodo(p) || (!p.goal_id && !e.done))) e.day = todayKey;
    else if (e.day && e.day < todayKey && !e.done) {
      e.overdue = true;
      e.day = todayKey;
    }
    if (!e.day || inSession.has(`${e.day}:${p.id}`)) return;
    push(e);
  });

  for (const k of keys) byDay[k].sort(compareEvents);
  return byDay;
}

/**
 * A month in numbers: per goal, hours of sessions planned and hours whose task is done; plus milestones due,
 * reminder occurrences, to-dos (open / done) and away ranges.
 */
export function summarize(byDay, goals = []) {
  const perGoal = new Map();
  const c = { milestones: [], reminders: 0, reminderTitles: new Set(), todosOpen: 0, todosDone: 0, away: new Set() };
  Object.values(byDay).forEach((events) =>
    events.forEach((e) => {
      if (e.kind === EVENT_KIND.session && e.goalId) {
        const g = perGoal.get(e.goalId) || { planned: 0, done: 0 };
        const h = blockHours(e.raw);
        g.planned += h;
        if (e.done) g.done += h;
        perGoal.set(e.goalId, g);
      } else if (e.kind === EVENT_KIND.milestone) c.milestones.push(e);
      else if (e.kind === EVENT_KIND.reminder) {
        c.reminders += 1;
        c.reminderTitles.add(e.title);
      } else if (e.kind === EVENT_KIND.todo) e.done ? (c.todosDone += 1) : (c.todosOpen += 1);
      else if (e.kind === EVENT_KIND.away) c.away.add(e.raw.id);
    }),
  );
  const goalRows = goals
    .filter((g) => g.status !== "dropped")
    .map((g) => ({ goal: g, ...(perGoal.get(g.id) || { planned: 0, done: 0 }) }));
  return { goalRows, ...c, reminderTitles: [...c.reminderTitles], awayCount: c.away.size };
}
