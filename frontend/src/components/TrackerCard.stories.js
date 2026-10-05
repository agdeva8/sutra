import { fn } from "storybook/test";
import TrackerCard from "./TrackerCard";
import { localDateKey } from "../lib/utils";

const day = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return localDateKey(d);
};

// TrackerCard derives "today" from the user's MILESTONES (commitments were
// removed from the product).
const state = {
  goals: [
    { id: "g1", title: "Run a marathon", status: "active" },
    { id: "g2", title: "Ship the v2 landing page", status: "paused" },
  ],
  milestones: [
    { id: "m1", title: "Easy 5k before work", status: "open", target_date: day(0), goal_title: "Run a marathon" },
    { id: "m2", title: "Rewrite the CV summary", status: "open", target_date: day(-1), goal_title: "Ship the v2 landing page" },
    { id: "m3", title: "Send the copy to review", status: "done", target_date: day(0), goal_title: "Ship the v2 landing page" },
    { id: "m4", title: "First 10k race", status: "open", target_date: day(2), goal_title: "Run a marathon" },
  ],
};

// The card renders TodayTimetable underneath, which fetches blockers +
// timetable itself.
const blockers = [];
const timetable = { blocks: [] };

export default {
  title: "Components/TrackerCard",
  component: TrackerCard,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
    api: { blockers, timetable },
  },
  args: {
    state,
    onChange: fn(),
    onOpenChat: fn(),
  },
};

export const Default = {};
