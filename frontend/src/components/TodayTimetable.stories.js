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

// Today's view combines direct blockers/commitments with timed blocks.
const blockers = [
  {
    id: "b1",
    title: "Deep-work block: no meetings",
    start_date: day(0),
    end_date: day(0),
    note: "Protect the morning",
  },
];

const commitments = [
  { id: "c1", text: "Rewrite the CV summary", due: day(-1), status: "open", goal_title: "Switch into platform engineering", note: "" },
  { id: "c2", text: "Easy 5k before work", due: day(0), status: "open", goal_title: "Run a marathon", note: "" },
  { id: "c3", text: "Send the landing page copy to review", due: day(0), status: "done", goal_title: "Ship the v2 landing page", note: "Sent 09:40" },
];
const timetable = {
  blocks: [
    { id: "t1", block_date: day(0), start_time: "09:00", end_time: "10:30", label: "System design practice", kind: "focus", goal_title: "Switch jobs" },
  ],
};

export default {
  title: "Components/TodayTimetable",
  component: TodayTimetable,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
    api: { blockers, commitments, timetable },
  },
  args: {
    state: {},
    onChange: fn(),
    onOpenChat: fn(),
    compact: false,
    fullTimetable: true,
  },
};

export const Default = {};
