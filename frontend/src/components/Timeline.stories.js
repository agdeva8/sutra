import { fn } from "storybook/test";
import Timeline from "./Timeline";
import { localDateKey } from "../lib/utils";

// Dates anchor to the current month so the default calendar view always
// shows bars wherever "today" happens to be.
const day = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return localDateKey(d);
};

const state = {
  goals: [
    {
      id: "g1",
      title: "Run a marathon",
      status: "active",
      horizon: "long",
      start_date: day(-10),
      target_date: day(75),
      created_at: day(-30),
      next_action: "Book the physio session",
      phase_objectives: { Base: "Complete four weeks of planned training", Build: "Finish a 10k race rehearsal" },
    },
    {
      id: "g2",
      title: "Switch into platform engineering",
      status: "active",
      horizon: "medium",
      start_date: day(-5),
      target_date: day(35),
      created_at: day(-20),
      next_action: "Rewrite the CV summary",
    },
    {
      id: "g3",
      title: "Ship the v2 landing page",
      status: "paused",
      horizon: "weekly",
      start_date: day(-2),
      target_date: day(9),
      created_at: day(-7),
      next_action: "Outline the five sections",
    },
  ],
  milestones: [
    { id: "m1", goal_id: "g1", goal_title: "Run a marathon", title: "First 10k race", status: "open", target_date: day(6) },
    { id: "m2", goal_id: "g2", goal_title: "Switch into platform engineering", title: "Three informational calls", status: "open", target_date: day(12) },
    { id: "m3", goal_id: "g3", goal_title: "Ship the v2 landing page", title: "Copy approved", status: "done", target_date: day(-3) },
  ],
  commitments: [
    { id: "c1", text: "Easy 5k before work", due: day(1), status: "open", goal_title: "Run a marathon" },
    { id: "c2", text: "Rewrite the CV summary", due: day(-1), status: "open", goal_title: "Switch into platform engineering" },
    { id: "c3", text: "Send the copy to review", due: day(-3), status: "done", goal_title: "Ship the v2 landing page" },
  ],
  blockers: [
    { id: "b1", title: "Conference week", start_date: day(3), end_date: day(5) },
    { id: "b2", title: "Launch crunch", start_date: day(7), end_date: day(14) },
  ],
  audit_summary: {
    recent: [
      { created_at: `${day(-2)}T10:00:00`, type: "goal_created", summary: "Created Run a marathon" },
      { created_at: `${day(-1)}T16:30:00`, type: "commitment_confirmed", summary: "Added commitment Easy 5k before work" },
    ],
  },
  sources: [
    { created_at: day(-4), kind: "file", original_filename: "race-plan-2026.pdf" },
    { created_at: day(-3), kind: "link", original_filename: "Platform engineering roadmap" },
  ],
};

export default {
  title: "Components/Timeline",
  component: Timeline,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen", api: { timetable: { blocks: [] } } },
  args: {
    state,
    onPrefill: fn(),
    onOpenChatWith: fn(),
    onOpenChat: fn(),
  },
};

export const Default = {};
