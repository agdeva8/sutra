import React, { useState } from "react";
import CalendarMonthNested, { GoalFilter } from "./CalendarMonthNested";

/**
 * The REAL month view (imported by Timeline): goal ▸ milestone ▸ weekly task
 * nested boxes, driven by the same shapes the app passes — goals with a resolved
 * span, normalized milestones, and raw `state.plan_items`.
 */

const PALETTE = ["#0A84FF", "#34C759", "#FF9F0A", "#BF5AF2", "#FF375F", "#5AC8FA"];

const now = new Date();
const at = (day) => new Date(now.getFullYear(), now.getMonth(), day);
const iso = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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

export default { title: "Timeline/Calendar month nested (real)", parameters: { layout: "fullscreen" } };

export const Default = () => {
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
      <GoalFilter goals={goals} selected={selected} onToggle={toggle} onAll={() => setSelected(new Set(goals.map((g) => g.id)))} />
      <CalendarMonthNested
        anchor={now}
        goals={goals}
        milestones={milestones}
        planItems={planItems}
        selectedGoalIds={selected}
        onSelectItem={() => {}}
        onSelectDay={() => {}}
      />
    </div>
  );
};
