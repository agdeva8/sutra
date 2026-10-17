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

const hhmm = (t) => (t ? String(t).slice(0, 5) : "");
const dayOf = (v) => (v ? String(v).slice(0, 10) : null);

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

/** A timetable block: a repeating commitment's occurrence, a fixed commitment, or a goal session. */
export function blockEvent(b, { taskById = new Map(), goalTitle = "" } = {}) {
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

/** Every occurrence of a reminder (each day x each time). */
export function reminderEvents(r, goalTitle = "") {
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
    done: m.status === STATUS_DONE, raw: m,
  });
}

/** An away range as one event per day it covers, for the days in `keys`. */
export function awayEvents(b, keys) {
  const s = dayOf(b.start_date);
  const e = dayOf(b.end_date || b.start_date);
  if (!s) return [];
  return keys.filter((k) => k >= s && k <= e).map((k) => base(EVENT_KIND.away, KIND_STYLE.blocker.color, { id: `away-${b.id}-${k}`, title: b.title, day: k, raw: b }));
}
