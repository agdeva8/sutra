import React from "react";
import CalendarMonthGrid from "./CalendarMonthGrid";

/**
 * Timeline month view. Single-day items are Option C breadcrumb cards;
 * only genuinely multi-day items (a blocker over a trip, a multi-day task)
 * draw one spanning bar. Goals are context, not cards.
 */

const day = (offset) => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return d;
};

const card = (id, kind, title, start, end, color, extra = {}) => ({
  id,
  item: { id, kind, title, start: day(start), end: day(end) },
  date: day(start),
  glyph: kind === "milestone" ? "◆" : kind === "blocker" ? "▲" : "○",
  title,
  color,
  ...extra,
});

const BLUE = "#3B6FF0";
const AMBER = "#C8892B";
const RED = "var(--danger)";

const cards = [
  // multi-day — spanning bars
  card("b1", "blocker", "Conference week", 3, 9, RED),
  card("b2", "blocker", "Launch crunch", 12, 25, RED),
  card("t1", "task", "Write the design doc", 5, 8, BLUE, { fulfils: "MVP shipped", hours: "2d" }),
  // single-day — cards
  card("m1", "milestone", "First 10k race", 6, 6, AMBER, { goalTitle: "Run a marathon" }),
  card("t2", "task", "Draft target-role list", 2, 2, BLUE, { goalTitle: "Switch into platform engineering", fulfils: "Target list written", hours: "1.5h" }),
];

export default {
  title: "Components/CalendarMonthGrid",
  parameters: { layout: "fullscreen" },
};

export const Default = () => (
  <div className="min-h-[720px] bg-[var(--bg-primary)] p-4">
    <CalendarMonthGrid
      anchor={new Date()}
      cards={cards}
      today={new Date()}
      onSelectItem={() => {}}
      onSelectDay={() => {}}
    />
  </div>
);
