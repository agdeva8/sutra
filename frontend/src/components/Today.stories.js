import { fn } from "storybook/test";
import Today from "./Today";
import { localDateKey } from "../lib/utils";

// Items are filtered against today's local date key, so "today" and a
// couple of days out keep the list populated whenever the story is opened.
const day = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return localDateKey(d);
};

const blockers = [
  {
    id: "b1",
    title: "Deep-work block: no meetings",
    start_date: day(0),
    end_date: day(0),
    note: "Protect the morning",
  },
];

const state = {
  goals: [
    { id: "g1", title: "Run a marathon", status: "active", horizon: "long" },
    { id: "g2", title: "Switch into platform engineering", status: "active", horizon: "medium" },
    { id: "g3", title: "Ship the v2 landing page", status: "paused", horizon: "weekly" },
  ],
  plan_items: [
    { id: "p1", horizon: "daily", title: "Rewrite the CV summary", due_date: day(-1), status: "open", goal_id: "g2", note: 'Fulfils "Resume" · 1.5h' },
    { id: "p2", horizon: "daily", title: "Easy 5k before work", due_date: day(0), status: "open", goal_id: "g1", note: 'Fulfils "Base fitness" · 1h' },
    { id: "p3", horizon: "daily", title: "Send the landing page copy to review", due_date: day(0), status: "done", goal_id: "g3", note: 'Fulfils "Copy" · 0.5h' },
  ],
};

export default {
  title: "Components/Today",
  component: Today,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
    api: { blockers, timetable: { blocks: [] } },
  },
  args: {
    state,
    onChange: fn(),
    onOpenChat: fn(),
  },
};

export const Default = {};

export const Empty = {
  args: { state: { goals: [], plan_items: [] } },
  parameters: {
    api: { blockers: [], timetable: { blocks: [] } },
  },
};
