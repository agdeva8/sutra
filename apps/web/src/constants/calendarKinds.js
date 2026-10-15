/**
 * How each kind of thing looks on the calendar: a symbol, a colour and a texture, so a card can be told
 * apart at a glance without reading it. One table, so Day, Week, Month, 3 Months and Year all agree.
 *
 * Tasks and time slots take their goal's colour (so a goal reads as one colour everywhere). Reminders and
 * repeating commitments each get a colour of their own per reminder / per series, from palettes no goal
 * uses, so "take meds" is the same colour on every day it falls on.
 *   - `color: null` means "the colour of the thing it belongs to" (its goal, reminder or series).
 *   - `look` is the texture, so a kind still reads apart when two colours are close:
 *       "wash"    light fill + left bar      — goal work (the reference style)
 *       "stripes" hatched                    — time that is taken away
 *       "pill"    outlined, rounded, no bar  — a reminder: a moment, not work
 *       "dashed"  light fill + dashed border — a repeating commitment
 *       "outline" page background + thin border + left tick bar — a to-do: a list item, not planned time
 */
import { createElement } from "react";
import { Bell, CalendarOff, CalendarRange, CircleCheck, Flag, ListTodo, Lock, Repeat, Target, Timer } from "lucide-react";

/** Glyphs scale with the text they sit in (1em), so a card's icon matches its title at any density. */
const GLYPH_SIZE = "1em";
const GLYPH_STROKE = 2.25;
const kindIcon = (Icon) =>
  createElement(Icon, { size: GLYPH_SIZE, strokeWidth: GLYPH_STROKE, "aria-hidden": true, style: { display: "inline-block", verticalAlign: "-0.125em" } });

export const KIND_STYLE = {
  task: { glyph: kindIcon(CircleCheck), label: "Task", color: null, look: "wash" },
  session: { glyph: kindIcon(Timer), label: "Time slot", color: null, look: "wash" },
  fixed: { glyph: kindIcon(Lock), label: "Commitment", color: "var(--text-secondary)", look: "wash" },
  blocker: { glyph: kindIcon(CalendarOff), label: "Away", color: "var(--danger)", look: "stripes" },
  milestone: { glyph: kindIcon(Flag), label: "Milestone", color: null, look: "wash" },
  reminder: { glyph: kindIcon(Bell), label: "Reminder", color: null, look: "pill" },
  recurring: { glyph: kindIcon(Repeat), label: "Repeats", color: null, look: "dashed" },
  todo: { glyph: kindIcon(ListTodo), label: "To-do", color: null, look: "outline" },
};
/** Glyphs for things drawn outside the per-kind table: a goal's span and a week of its plan. */
export const GOAL_GLYPH = kindIcon(Target);
export const WEEK_GLYPH = kindIcon(CalendarRange);

/** A to-do's priority, as the API spells it (agentv2 `TODO_PRIORITIES`). */
export const TODO_PRIORITY_LOW = "low";
export const TODO_PRIORITY_NORMAL = "normal";
export const TODO_PRIORITY_HIGH = "high";
export const TODO_PRIORITIES = [
  { key: TODO_PRIORITY_HIGH, label: "High", rank: 0, color: "var(--danger)" },
  { key: TODO_PRIORITY_NORMAL, label: "Normal", rank: 1, color: "var(--accent)" },
  { key: TODO_PRIORITY_LOW, label: "Low", rank: 2, color: "var(--text-muted)" },
];
export const TODO_PRIORITY_BY_KEY = Object.fromEntries(TODO_PRIORITIES.map((p) => [p.key, p]));
/** A to-do's colour is its priority's, so "high" reads at a glance on every screen. */
export const todoColor = (priority) => (TODO_PRIORITY_BY_KEY[priority] || TODO_PRIORITY_BY_KEY[TODO_PRIORITY_NORMAL]).color;
/** `plan_items.item_type` of a to-do (a goal's task has none). */
export const ITEM_TYPE_TODO = "todo";

/** `timetable_blocks.kind` of a fixed commitment (sutra_api `KIND_COMMITTED`). */
export const BLOCK_KIND_COMMITMENT = "commitment";
/** `kind` GET /timetable gives a reminder's occurrence when it lists reminders among the blocks (sutra_api `KIND_REMINDER`). */
export const BLOCK_KIND_REMINDER = "reminder";
/**
 * A block is goal work when it belongs to a goal, whether the planner placed it (tentative) or the user named
 * the time (commitment). Everything else (a commitment, a focus block, a slot with no goal) is the user's own
 * time and draws as a commitment, to keep the kinds few. A repeating commitment is drawn by its series first.
 */
export const isGoalSession = (b) => !!b?.goal_id;

/** `timetable_blocks.source` of a repeating commitment's occurrences (`source_id` is the series). */
export const SOURCE_RECURRING = "recurring";

/*
 * Per-thing palettes. Mid-tone hues, because a card's fill is the colour mixed toward the page background
 * (so it is light in the light theme and dark in the dark one) and its edge is the colour itself, which has
 * to read on both. The three families are kept apart: goals are the system hues, reminders the magenta /
 * violet family, repeating commitments the earthy / teal family.
 */
export const GOAL_PALETTE = ["#0A84FF", "#34C759", "#FF9F0A", "#BF5AF2", "#FF375F", "#5AC8FA"];
export const REMINDER_PALETTE = ["#D63CC9", "#9B5CF6", "#E0559B", "#7C6CF2", "#C2410C", "#DB2777"];
export const RECURRING_PALETTE = ["#0F9D8A", "#A16207", "#4F7CAC", "#65A30D", "#B4637A", "#0E7490"];

/** A stable index for an id: the same id lands on the same colour on every render, screen and session. */
function hashId(id) {
  const s = String(id || "");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** The colour `palette` gives `id` — deterministic, so it never shifts when other items come and go. */
export const colorForId = (palette, id) => palette[hashId(id) % palette.length];
export const goalColor = (goalId) => colorForId(GOAL_PALETTE, goalId);
export const reminderColor = (reminderId) => colorForId(REMINDER_PALETTE, reminderId);
export const recurringColor = (seriesId) => colorForId(RECURRING_PALETTE, seriesId);

/** How strongly each look tints its fill toward the card's colour, in percent. */
const FILL_PCT = { wash: 16, pill: 10, dashed: 12, outline: 4, stripesDark: 24, stripesLight: 10 };

/**
 * The card surface for a colour and look, as inline style. One function so the hour grid, the month grid
 * and the card list draw a kind the same way.
 */
export function cardSurface(color, look) {
  const mix = (pct) => `color-mix(in srgb, ${color} ${pct}%, var(--bg-primary))`;
  switch (look) {
    case "stripes":
      return {
        background: `repeating-linear-gradient(135deg, ${mix(FILL_PCT.stripesDark)} 0 6px, ${mix(FILL_PCT.stripesLight)} 6px 12px)`,
        boxShadow: `inset 3px 0 0 0 ${color}`,
      };
    case "pill":
      return { background: mix(FILL_PCT.pill), boxShadow: `inset 0 0 0 1.5px ${color}`, borderRadius: 999 };
    case "outline":
      return { background: mix(FILL_PCT.outline), boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${color} 45%, var(--border)), inset 3px 0 0 0 ${color}` };
    case "dashed":
      return { background: mix(FILL_PCT.dashed), outline: `1.5px dashed ${color}`, outlineOffset: -1.5 };
    default:
      return { background: mix(FILL_PCT.wash), boxShadow: `inset 3px 0 0 0 ${color}` };
  }
}

/** A reminder is drawn as a short slot at its time; this is how long. */
export const REMINDER_SLOT_MINUTES = 30;
