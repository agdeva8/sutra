import React, { useMemo, useState } from "react";
import { buildAgenda, dayKeys } from "../lib/agenda";
import { localDateKey } from "../lib/utils";
import { AgendaDay, AgendaWeek, MonthSummary, RangeTabs } from "./TodayAgenda";

/** The Today tab's agenda over a sample board: every calendar kind in its own look, at phone width. */

const key = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return localDateKey(d);
};
const T0 = key(0);
const GOAL = "goal_switch_jobs";

const STATE = {
  goals: [{ id: GOAL, title: "Switch jobs in 3 months", status: "active" }, { id: "goal_book", title: "Write a book", status: "active" }],
  timetable_blocks: [
    { id: "b1", block_date: T0, start_time: "07:00", end_time: "08:00", label: "Gym", kind: "committed", source: "recurring", source_id: "rec_gym" },
    { id: "b2", block_date: T0, start_time: "10:00", end_time: "10:30", label: "Standup", kind: "committed", source: "user" },
    { id: "b3", block_date: T0, start_time: "18:00", end_time: "19:30", label: "Leetcode: graphs", kind: "tentative", source: "agent", source_id: "t1", goal_id: GOAL, goal_title: "Switch jobs in 3 months" },
    { id: "b4", block_date: key(1), start_time: "20:00", end_time: "21:00", label: "Draft chapter 2", kind: "tentative", source: "agent", source_id: "t2", goal_id: "goal_book" },
    { id: "b5", block_date: key(2), start_time: "07:00", end_time: "08:00", label: "Gym", kind: "committed", source: "recurring", source_id: "rec_gym" },
  ],
  plan_items: [
    { id: "t1", horizon: "daily", title: "Leetcode: graphs", goal_id: GOAL, due_date: T0, status: "open" },
    { id: "t2", horizon: "daily", title: "Draft chapter 2", goal_id: "goal_book", due_date: key(1), status: "done" },
    { id: "t3", horizon: "daily", item_type: "todo", priority: "high", title: "Reply to Mohit", goal_id: null, due_date: null, status: "open" },
    { id: "t4", horizon: "daily", item_type: "todo", priority: "normal", title: "Pay rent", goal_id: null, due_date: T0, due_time: "17:00", status: "open" },
    { id: "t5", horizon: "daily", item_type: "todo", priority: "low", title: "Buy stamps", goal_id: null, due_date: T0, status: "done" },
  ],
  reminders: [{ id: "rem_meds", title: "Take meds", days: [T0, key(1), key(2), key(3)], times: ["13:00"] }],
  milestones: [{ id: "m1", title: "Resume reviewed", goal_id: GOAL, target_date: T0, status: "open" }],
  blockers: [{ id: "a1", title: "Away: Goa trip", start_date: key(3), end_date: key(4) }],
};

function Agenda({ initialRange }) {
  const [range, setRange] = useState(initialRange);
  const keys = range === "today" ? [T0] : range === "week" ? dayKeys(new Date(), 7) : dayKeys(new Date(), 30);
  const byDay = useMemo(() => buildAgenda(STATE, keys), [range]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="mx-auto w-full max-w-[420px] space-y-4 p-4">
      <RangeTabs value={range} onChange={setRange} />
      {range === "today" && (
        <>
          <AgendaDay entries={byDay[T0]} onCant={() => {}} onBreakDown={() => {}} />
        </>
      )}
      {range === "week" && <AgendaWeek byDay={byDay} />}
      {range === "month" && <MonthSummary byDay={byDay} goals={STATE.goals} />}
    </div>
  );
}

export default { title: "Components/TodayAgenda", component: Agenda, parameters: { layout: "fullscreen" } };

export const Today = { args: { initialRange: "today" } };
export const ThisWeek = { args: { initialRange: "week" } };
export const ThisMonth = { args: { initialRange: "month" } };
