import React, { useState } from "react";
import CalendarNestedView, { GoalFilter } from "./CalendarNestedView";

/**
 * The REAL nested calendar (imported by Timeline) at every zoom: goal ▸
 * milestone ▸ weekly task boxes. The column unit is the smallest unit of the
 * span — day columns (Day/Week/Month), week columns (3 Months), month columns
 * (Year). Passing only `anchor` keeps the original single-month view.
 */

const PALETTE = ["#0A84FF", "#34C759", "#FF9F0A", "#BF5AF2", "#FF375F", "#5AC8FA"];

const now = new Date();
const at = (day) => new Date(now.getFullYear(), now.getMonth(), day);
const iso = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (d, n) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();

const GOAL_DEFS = [
  { id: "g1", title: "Switch into platform engineering", start: 1, end: daysInMonth, phases: ["Foundations", "Apply"] },
  { id: "g2", title: "Run a half marathon", start: 1, end: 28, phases: ["Base", "Long run"] },
  { id: "g3", title: "Ship the side-project MVP", start: 5, end: daysInMonth, phases: ["Core", "Ship"] },
];

const goals = GOAL_DEFS.map((g, i) => ({ id: g.id, title: g.title, start: at(g.start), end: at(g.end), color: PALETTE[i] }));

const milestones = GOAL_DEFS.flatMap((g) => [
  { id: `${g.id}-m1`, goalId: g.id, title: `${g.phases[0]} checkpoint`, date: at(Math.min(daysInMonth, 12 + (g.start % 4))), phase: g.phases[0] },
  { id: `${g.id}-m2`, goalId: g.id, title: `${g.phases[1]} checkpoint`, date: at(Math.min(daysInMonth, 26)), phase: g.phases[1] },
]);

const planItems = GOAL_DEFS.flatMap((g) => [
  { id: `${g.id}-w1`, goal_id: g.id, horizon: "weekly", phase: g.phases[0], title: "Week 1 focus", start_date: iso(at(1)), end_date: iso(at(7)), weekly_hours: 5 },
  { id: `${g.id}-w2`, goal_id: g.id, horizon: "weekly", phase: g.phases[0], title: "Week 2 focus", start_date: iso(at(8)), end_date: iso(at(14)), weekly_hours: 4 },
  { id: `${g.id}-w3`, goal_id: g.id, horizon: "weekly", phase: g.phases[1], title: "Week 3 focus", start_date: iso(at(15)), end_date: iso(at(21)), weekly_hours: 5 },
  { id: `${g.id}-w4`, goal_id: g.id, horizon: "weekly", phase: g.phases[1], title: "Week 4 focus", start_date: iso(at(22)), end_date: iso(at(Math.min(daysInMonth, 28))), weekly_hours: 3 },
]);

const blockers = [
  { id: "b1", title: "Conference week", start: at(8), end: at(10), note: "Out of office — no deep work." },
];

export default { title: "Timeline/Calendar nested (real)", parameters: { layout: "fullscreen" } };

function Harness({ start, end, unit, label }) {
  const [selected, setSelected] = useState(() => new Set(goals.map((g) => g.id)));
  const toggle = (id) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        if (next.size === 1) return prev;
        next.delete(id);
      } else next.add(id);
      return next;
    });
  return (
    <div className="min-h-screen space-y-2 bg-[var(--bg-primary)] p-4">
      <div className="text-xs font-semibold text-[var(--text-secondary)]">{label}</div>
      <GoalFilter goals={goals} selected={selected} onToggle={toggle} onAll={() => setSelected(new Set(goals.map((g) => g.id)))} />
      <CalendarNestedView
        start={start}
        end={end}
        unit={unit}
        goals={goals}
        milestones={milestones}
        planItems={planItems}
        blockers={blockers}
        selectedGoalIds={selected}
        onSelectItem={() => {}}
        onSelectDay={() => {}}
      />
    </div>
  );
}

export const Month_DayColumns = () => <Harness start={at(1)} end={at(daysInMonth)} unit="day" label="Month — day columns" />;

export const Week_DayColumns = () => {
  const weekStart = addDays(now, -((now.getDay() + 6) % 7));
  return <Harness start={weekStart} end={addDays(weekStart, 6)} unit="day" label="Week — 7 day columns" />;
};

export const DayFallback_OneRowPerGoal = () => <Harness start={at(5)} end={at(5)} unit="day" label="Day — one nested row per goal" />;

export const ThreeMonths_WeekColumns = () => <Harness start={at(1)} end={addDays(at(1), 89)} unit="week" label="3 Months — week columns" />;

export const Year_MonthColumns = () => (
  <Harness start={new Date(now.getFullYear(), 0, 1)} end={new Date(now.getFullYear(), 11, 31)} unit="month" label="Year — month columns" />
);
