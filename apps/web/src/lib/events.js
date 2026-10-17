/**
 * Event: the one shape every dated thing takes on the client, whatever row it came from.
 *
 *   { id, kind, title, day, start?, end?, done, goalId?, goalTitle?, color, glyph, look, raw, ...per-kind }
 *
 * `kind` is one of EVENT_KIND. Each builder below reads one server row and fills the base fields plus its
 * own extras (a todo's `priority`/`dueTime`/`task`, a session's linked `task`, a reminder's `time`), and
 * takes its look from `constants/calendarKinds.js`. Screens (Today, Todos, Timeline) list Events and switch
 * on `kind` only where a kind genuinely behaves differently — e.g. only a goal `task` gets goal actions.
 */
import {
  KIND_STYLE,
  SOURCE_RECURRING,
  GOAL_PALETTE,
  ITEM_TYPE_TODO,
  goalColor,
  reminderColor,
  recurringColor,
  todoColor,
  isGoalSession,
  BLOCK_KIND_REMINDER,
} from "../constants/calendarKinds";
import { blockColor } from "../constants/blockKinds";

export const EVENT_KIND = {
  session: "session", // a goal's planned time slot
  task: "task", // a goal's task with a day but no slot
  todo: "todo",
  reminder: "reminder",
  milestone: "milestone",
  commitment: "commitment", // a fixed, one-off block
  recurring: "recurring", // an occurrence of a repeating commitment
  away: "away",
  block_event: "block_event",
  block_task: "block_task",
  block_away: "block_away",
  block_milestone: "block_milestone",
};

/** The calendarKinds key that draws each event kind. */
const STYLE_KEY = { commitment: "fixed", away: "blocker" };
const STATUS_DONE = "done";
const STATUS_OPEN = "open";
const BLOCK_KIND_TASK = "task";
const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;
const WEEKDAYS_PER_WEEK = 7;
const DAY_MS = 86400000;

const hhmm = (t) => (t ? String(t).slice(0, 5) : "");
const dayOf = (v) => (v ? String(v).slice(0, 10) : null);
const toMin = (t) => {
  const [h, m] = String(t || "").slice(0, 5).split(":").map(Number);
  return (h || 0) * MINUTES_PER_HOUR + (m || 0);
};

function base(kind, color, fields) {
  const k = KIND_STYLE[STYLE_KEY[kind] || kind];
  return { kind, color, glyph: k.glyph, look: k.look, label: k.label, done: false, ...fields };
}

/** True for a `plan_items` row that is a to-do rather than a goal's task. */
export const isTodo = (p) => p?.item_type === ITEM_TYPE_TODO;

/** A to-do row. `day` is its due day (null = undated). */
export function todoEvent(p, goalTitle = "") {
  return base(EVENT_KIND.todo, todoColor(p.priority), {
    id: `todo-${p.id}`, title: p.title, day: dayOf(p.due_date), time: hhmm(p.due_time), dueTime: hhmm(p.due_time),
    priority: p.priority, note: p.description || "", goalId: p.goal_id, goalTitle, done: p.status === STATUS_DONE,
    task: p, raw: p,
  });
}

/** A goal's task with a day and no slot. */
export function taskEvent(p, goalTitle = "") {
  const fields = {
    id: `task-${p.id}`, title: p.title, day: dayOf(p.due_date), goalId: p.goal_id, goalTitle,
    done: p.status === STATUS_DONE, note: p.description || "", task: p, raw: p,
  };
  if (p.goal_id) return base(EVENT_KIND.task, goalColor(p.goal_id), fields);
  // A task with no goal is the user's own item: it still ticks off like a task, but draws as a commitment.
  const fixed = KIND_STYLE.fixed;
  return { ...base(EVENT_KIND.task, fixed.color, fields), glyph: fixed.glyph, look: fixed.look, label: fixed.label };
}

/** A plan item as whichever event it is. */
export const planItemEvent = (p, goalTitle) => (isTodo(p) ? todoEvent(p, goalTitle) : taskEvent(p, goalTitle));

/** True for a `calendar_blocks` row (the 4-kind model), false for an old timetable / plan row. */
export const isFourKindBlock = (b) => !!b?.block_kind;

/** A 4-kind task is ticked when `done` is set or its richer `state` says done. */
export const blockDone = (b) => b?.done === true || b?.state === STATUS_DONE;

/** Hours a block covers: `effort_hours` when it carries one, else the span of its times, else none. */
export function blockHours(b) {
  if (typeof b?.effort_hours === "number") return b.effort_hours;
  const start = b?.start ?? b?.start_time;
  const end = b?.end ?? b?.end_time;
  if (!start || !end) return 0;
  let mins = toMin(end) - toMin(start);
  if (mins <= 0) mins += MINUTES_PER_DAY;
  return mins / MINUTES_PER_HOUR;
}

/** Monday = 0, matching the contract's `Repeat.weekdays`. */
const weekdayOf = (key) => (new Date(`${key}T00:00:00`).getDay() + WEEKDAYS_PER_WEEK - 1) % WEEKDAYS_PER_WEEK;

/** The block's own day, for kinds that have no `day` field (a milestone's target date). */
const blockDay = (b) => dayOf(b?.day ?? b?.target_date);

/** A Date as its local ISO day key ("YYYY-MM-DD"). */
const isoDay = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Day keys in `keys` the block falls on. Without a repeat that is its own day. */
export function repeatDays(b, keys) {
  const first = blockDay(b);
  if (!b?.repeat) return first ? [first] : [];
  const until = dayOf(b.repeat.until);
  const weekdays = b.repeat.weekdays || [];
  return keys.filter((k) => (!until || k <= until) && (!first || k >= first) && weekdays.includes(weekdayOf(k)));
}

/**
 * Every day the block's repeat covers, from its own day to `until`, matching its weekdays. This is
 * how a multi-day item knows its first and last day even when the screen only shows one of them.
 * Without a repeat (or without an `until`) it is just its own day.
 */
export function occurrenceDays(b) {
  const first = blockDay(b);
  if (!first) return [];
  const until = dayOf(b?.repeat?.until);
  const weekdays = b?.repeat?.weekdays || [];
  if (!until || until < first || !weekdays.length) return [first];
  const days = [];
  for (let d = new Date(`${first}T00:00:00`); isoDay(d) <= until; d = new Date(d.getTime() + DAY_MS)) {
    const key = isoDay(d);
    if (weekdays.includes(weekdayOf(key))) days.push(key);
  }
  return days;
}

/** A quota block: a task with a count per day (e.g. "send 5 applications"). */
export const isQuotaBlock = (b) => b?.block_kind === BLOCK_KIND_TASK && typeof b?.quota === "number" && b.quota > 0;

/** A multi-day item: an untimed, non-quota task whose repeat covers more than one day. */
export const isMultiDayBlock = (b) =>
  b?.block_kind === BLOCK_KIND_TASK && !b.at && !b.start && !b.end && !isQuotaBlock(b) && occurrenceDays(b).length > 1;

/** The instances done on `day` of a quota, as the contract's `quota_done` holds them. */
export const quotaDoneOn = (b, day) => Number(b?.quota_done?.[day] || 0);

/**
 * One occurrence of a 4-kind block, as the Event the screens already consume. The four kinds map onto
 * today's event kinds: an Event is a commitment (a repeat draws as a series), a Task is a goal session
 * when it is timed under a goal and a commitment when it is the user's own time, and a Task with an
 * `at` is a reminder.
 */
function blockEventOn(b, day, goalTitle, meta = {}) {
  const common = { id: `block-${b.id}-${day}`, title: b.title, day, raw: b, goalId: b.goal_id, goalTitle };
  if (b.block_kind === "event") {
    const fields = { ...common, time: hhmm(b.start), start: hhmm(b.start), end: hhmm(b.end) };
    const color = b.goal_id ? goalColor(b.goal_id) : KIND_STYLE.fixed.color;
    return base(b.repeat ? EVENT_KIND.recurring : EVENT_KIND.commitment, color, fields);
  }
  if (b.block_kind === "task") {
    const quota = isQuotaBlock(b) ? b.quota : null;
    const quotaDone = quota ? quotaDoneOn(b, day) : 0;
    // A quota is done per day, by its count; other tasks are done as a whole.
    const done = quota ? quotaDone >= quota : blockDone(b);
    const task = { ...b, status: done ? STATUS_DONE : STATUS_OPEN };
    // A to-do is a task the user placed. A reminder is also a task with `at`, so the explicit marker
    // decides — or, for a to-do the backfill copied before the marker existed, its `plan_items` id.
    if (b.todo === true || meta.todo === true) {
      return base(EVENT_KIND.todo, todoColor(b.priority), {
        ...common, time: hhmm(b.at), dueTime: hhmm(b.at), priority: b.priority,
        note: b.description || "", done, task,
      });
    }
    // A multi-day item says where in its run this day is ("Day 1 of 2").
    const span = meta.dayCount > 1 ? { dayIndex: meta.dayIndex, dayCount: meta.dayCount, anytime: true } : {};
    if (b.at) {
      return base(EVENT_KIND.reminder, reminderColor(b.id), { ...common, time: hhmm(b.at), task, done });
    }
    const timed = !!(b.start && b.end);
    const times = { time: hhmm(b.start), start: hhmm(b.start), end: hhmm(b.end) };
    if (timed && b.goal_id) return base(EVENT_KIND.session, goalColor(b.goal_id), { ...common, ...times, task, done });
    if (timed || !b.goal_id) return base(EVENT_KIND.commitment, KIND_STYLE.fixed.color, { ...common, ...times, task, done });
    const color = b.goal_id ? goalColor(b.goal_id) : KIND_STYLE.fixed.color;
    // A quota carries its count and the day's done count, so the row can draw "3/5" and step it.
    if (quota) return base(EVENT_KIND.task, color, { ...common, task, done, quota, quotaDone, anytime: true, ...span });
    return base(EVENT_KIND.task, color, { ...common, task, done, ...span });
  }
  return null;
}

/**
 * Every occurrence of a 4-kind block inside the agenda's range, as Events. `todayKey` catches a task
 * with no day: it is a list item, and Today lists it on today.
 */
export function blockEvents(b, keys, { goalTitle = "", todayKey = null, todoIds = null } = {}) {
  if (b?.block_kind === "away") return awayEvents(b, keys);
  if (b?.block_kind === "milestone") return [milestoneEvent(b, goalTitle)];
  const days = repeatDays(b, keys);
  if (!days.length && b?.block_kind === BLOCK_KIND_TASK && !b.day && todayKey) days.push(todayKey);
  // A multi-day item is one item across several days: number each occurrence so the row can say
  // "Day 2 of 3" rather than pretending the days are separate tasks.
  const span = isMultiDayBlock(b) ? occurrenceDays(b) : null;
  const todo = b?.todo === true || !!todoIds?.has(b?.id);
  return days
    .map((day) => {
      const index = span ? span.indexOf(day) : -1;
      return blockEventOn(b, day, goalTitle, {
        ...(span ? { dayIndex: index + 1, dayCount: span.length } : {}),
        ...(todo ? { todo: true } : {}),
      });
    })
    .filter(Boolean);
}

/** A timetable block: a repeating commitment's occurrence, a fixed commitment, or a goal session. */
export function blockEvent(b, { taskById = new Map(), goalTitle = "" } = {}) {
  // The dashboard's `timetableBlocks` are 4-kind event rows now; draw them as such.
  if (isFourKindBlock(b)) return blockEventOn(b, blockDay(b), goalTitle);
  const common = { id: `block-${b.id}`, title: b.label, day: dayOf(b.block_date), time: hhmm(b.start_time), start: hhmm(b.start_time), end: hhmm(b.end_time), raw: b };
  if (b.kind === BLOCK_KIND_REMINDER) return base(EVENT_KIND.reminder, reminderColor(b.source_id || b.label), { ...common, goalId: b.goal_id });
  if (b.source === SOURCE_RECURRING) return base(EVENT_KIND.recurring, recurringColor(b.source_id || b.label), { ...common, seriesId: b.source_id });
  const task = b.source_id ? taskById.get(b.source_id) || null : null;
  // A slot made for a goal-less task still ticks that task off when done.
  if (!isGoalSession(b)) return base(EVENT_KIND.commitment, KIND_STYLE.fixed.color, { ...common, task, done: task ? task.status === STATUS_DONE : false });
  return base(EVENT_KIND.session, goalColor(b.goal_id), {
    ...common, goalId: b.goal_id, goalTitle: b.goal_title || goalTitle, task, done: task ? task.status === STATUS_DONE : false,
  });
}

/** Every occurrence of a reminder (each day x each time), or a single 4-kind task with an `at`. */
export function reminderEvents(r, goalTitle = "") {
  if (isFourKindBlock(r)) {
    const e = blockEventOn(r, blockDay(r), goalTitle);
    return e ? [e] : [];
  }
  const out = [];
  (r.days || []).forEach((d) =>
    (r.times || []).forEach((t) =>
      out.push(base(EVENT_KIND.reminder, reminderColor(r.id), {
        id: `rem-${r.id}-${d}-${t}`, title: r.title, day: dayOf(d), time: hhmm(t), goalId: r.goal_id, goalTitle, raw: r,
      })),
    ),
  );
  return out;
}

export function milestoneEvent(m, goalTitle = "") {
  return base(EVENT_KIND.milestone, goalColor(m.goal_id), {
    id: `ms-${m.id}`, title: m.title, day: dayOf(m.target_date), goalId: m.goal_id, goalTitle: m.goal_title || goalTitle,
    // A 4-kind milestone says `reached`; an old row says `status`.
    done: m.reached === true || m.status === STATUS_DONE, raw: m,
  });
}

/** An away range as one event per day it covers, for the days in `keys`. */
export function awayEvents(b, keys) {
  const s = dayOf(b.start_date);
  const e = dayOf(b.end_date || b.start_date);
  if (!s) return [];
  return keys.filter((k) => k >= s && k <= e).map((k) => base(EVENT_KIND.away, KIND_STYLE.blocker.color, { id: `away-${b.id}-${k}`, title: b.title, day: k, raw: b }));
}
