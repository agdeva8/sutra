/**
 * The four calendar block kinds (docs/calendar-block-kinds.md, "Target model"): Event, Task, Away,
 * Milestone. Everything else — goal, time, repeat, alert, task state — is a property.
 *
 * How a block looks is one rule: **colour says who it belongs to, shape says what it is.**
 *   - Colour: the goal's colour when the block carries a goal (event, task, milestone — so an
 *     "interview at Google" Event reads in the same colour as the prep around it). Neutral grey when
 *     it belongs to no goal. Away is always danger red — it is never goal work.
 *   - Shape: a Task has something to tick, so it gets the left bar + checkbox. An Event has nothing
 *     to tick, so it is a flat wash with no bar. Away is hatched stripes. A Milestone is a flag chip —
 *     a checkpoint on a date, not time on the grid.
 *   - A dashed outline means it repeats. (Dashed has meant "repeats" since the old kinds shipped;
 *     it does NOT mean "the planner placed it".)
 * Colour is never the only cue: every kind keeps its own glyph and texture.
 */
import { createElement } from "react";
import { Bell, CalendarOff, CircleCheck, Flag, Lock, Repeat } from "lucide-react";
import { cardSurface, goalColor } from "./calendarKinds";

/** Glyphs scale with the text they sit in (1em), so a card's icon matches its title at any density. */
const GLYPH_SIZE = "1em";
const GLYPH_STROKE = 2.25;
const kindIcon = (Icon) =>
  createElement(Icon, { size: GLYPH_SIZE, strokeWidth: GLYPH_STROKE, "aria-hidden": true, style: { display: "inline-block", verticalAlign: "-0.125em" } });

/** Neutral colour for anything that belongs to no goal (the user's own time). */
export const NO_GOAL_COLOR = "var(--text-secondary)";

/** `deleteLabel` names the destructive action in the edit form's footer. It says "to-do" for a Task
 *  because that is what the thing is called on screen, while the kind itself stays `task`. */
export const KIND_META = {
  event: { glyph: kindIcon(Lock), label: "Event", hint: "Time taken — nothing to tick", deleteLabel: "Delete event" },
  task: { glyph: kindIcon(CircleCheck), label: "Task", hint: "Something you tick off", deleteLabel: "Delete to-do" },
  away: { glyph: kindIcon(CalendarOff), label: "Away", hint: "Whole days you are out", deleteLabel: "Delete time away" },
  milestone: { glyph: kindIcon(Flag), label: "Milestone", hint: "A checkpoint on a goal", deleteLabel: "Delete milestone" },
};
export const BLOCK_KINDS = Object.keys(KIND_META);

/** Property badges, shown small in a block's corner. */
export const REPEAT_GLYPH = kindIcon(Repeat);
export const ALERT_GLYPH = kindIcon(Bell);

/** A task's tick state. `done` matches the contract's `done: bool`; partial and skip need the
 *  contract to grow a state field (see docs/calendar-block-kinds.md) — the UI is ready for them. */
export const TASK_STATES = ["open", "done", "partial", "skip"];
export const TASK_STATE_GLYPH = { open: "", done: "✔", partial: "◐", skip: "–" };

/** Alert choices for the add/edit form: `alert_before` in minutes; 0 = at the time itself. */
export const ALERT_OPTIONS = [
  { value: null, label: "No alert" },
  { value: 0, label: "At the time" },
  { value: 5, label: "5 min before" },
  { value: 10, label: "10 min before" },
  { value: 15, label: "15 min before" },
  { value: 30, label: "30 min before" },
  { value: 60, label: "1 hour before" },
];

/** Weekday chips for a weekly repeat. Index matches the contract's `Repeat.weekdays` (Mon = 0). */
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** The colour a block reads in: its goal's, else neutral (Away is handled by its own texture). */
export function blockColor(block) {
  if (block?.goal_id) return goalColor(block.goal_id);
  return NO_GOAL_COLOR;
}

/** A task's tick state, from whichever shape the block carries. */
export function taskState(block) {
  if (!block) return "open";
  if (block.state && TASK_STATES.includes(block.state)) return block.state;
  return block.done ? "done" : "open";
}

/** A milestone is overdue when its target date has passed and it has not been reached. */
export function milestoneOverdue(block, today = new Date()) {
  if (block?.block_kind !== "milestone" || block.reached) return false;
  const target = new Date(`${block.target_date}T00:00:00`);
  return target < new Date(today.toDateString());
}

/**
 * The surface for a block, as inline style. Composes `cardSurface` so the fills stay in one table:
 * Task = wash + left bar (the reference look), Event = flat wash with no bar (nothing to tick),
 * Away = hatched stripes in danger red, Milestone = a rounded flag chip. A dashed outline is
 * layered on top when the block repeats. A ticked task drops to a near-transparent fill.
 */
export function blockSurface(block) {
  const kind = block?.block_kind;
  const repeating = !!block?.repeat;
  if (kind === "away") {
    return withRepeat(cardSurface("var(--danger)", "stripes"), block, "var(--danger)");
  }
  const color = blockColor(block);
  if (kind === "milestone") {
    const overdue = milestoneOverdue(block);
    const edge = overdue ? "var(--danger)" : color;
    const fill = block.reached ? 28 : 12;
    return withRepeat(
      {
        background: `color-mix(in srgb, ${edge} ${fill}%, var(--bg-primary))`,
        boxShadow: `inset 0 0 0 1.5px ${edge}`,
        borderRadius: 999,
      },
      block,
      edge,
    );
  }
  if (kind === "event") {
    // Flat: no left bar, because an event has nothing to tick.
    return withRepeat({ background: `color-mix(in srgb, ${color} 18%, var(--bg-primary))` }, block, color);
  }
  // Task — wash + left bar. Ticked work drops to a whisper so done days read as quiet.
  const look = taskState(block) === "open" ? 16 : 6;
  return withRepeat(
    { background: `color-mix(in srgb, ${color} ${look}%, var(--bg-primary))`, boxShadow: `inset 3px 0 0 0 ${color}` },
    block,
    color,
  );
}

function withRepeat(style, block, color) {
  if (!block?.repeat) return style;
  return { ...style, outline: `1.5px dashed ${color}`, outlineOffset: -1.5 };
}

/** "09:00–10:00", "at 18:00", "All day" or "" — how a block's time reads on its card. */
export function whenLabel(block) {
  const k = block?.block_kind;
  if (k === "away") return `${block.start_date} → ${block.end_date}`;
  if (k === "milestone") return block.target_date;
  if (k === "event" && !(block.start && block.end)) return "All day";
  if (block.start && block.end) return `${block.start}–${block.end}`;
  if (block.at) return `at ${block.at}`;
  return "";
}
