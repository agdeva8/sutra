import { fn } from "storybook/test";
import TodayTimetable from "./TodayTimetable";
import { localDateKey } from "../lib/utils";

// Items are filtered against today's local date key, so "today" and a
// couple of days out keep the list populated whenever the story is opened.
const day = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return localDateKey(d);
};

// Today's view combines blockers + timed blocks with the day's daily PLAN
// TASKS (plan_items; commitments were removed from the product).
const blockers = [
  {
    id: "b1",
    title: "Deep-work block: no meetings",
    start_date: day(0),
    end_date: day(0),
    note: "Protect the morning",
  },
];

const timetable = {
  blocks: [
    { id: "t1", block_date: day(0), start_time: "09:00", end_time: "10:30", label: "System design practice", kind: "focus", goal_title: "Switch jobs" },
  ],
};

const state = {
  plan_items: [
    { id: "p1", horizon: "daily", title: "Rewrite the CV summary", due_date: day(-1), status: "open", note: 'Fulfils "Resume" · 1.5h' },
    { id: "p2", horizon: "daily", title: "Easy 5k before work", due_date: day(0), status: "open", goal_title: "Run a marathon", note: 'Fulfils "Base fitness" · 1h' },
    { id: "p3", horizon: "daily", title: "Send the landing page copy to review", due_date: day(0), status: "done", goal_title: "Ship the v2 landing page", note: 'Fulfils "Copy" · 0.5h' },
  ],
};

export default {
  title: "Components/TodayTimetable",
  component: TodayTimetable,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
    api: { blockers, timetable },
  },
  args: {
    state,
    onChange: fn(),
    onOpenChat: fn(),
    compact: false,
    fullTimetable: true,
  },
};

export const Default = {};
