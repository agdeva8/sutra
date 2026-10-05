import { fn } from "storybook/test";
import TrackingDashboard from "./TrackingDashboard";
import { localDateKey } from "../lib/utils";

const day = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return localDateKey(d);
};

const state = {
  goals: [
    {
      id: "g1",
      title: "Switch into platform engineering",
      status: "active",
      horizon: "medium",
      why: "I want work that compounds instead of firefighting.",
      target_date: day(35),
      next_action: "Rewrite the CV summary",
      sources: [
        { id: "s1", kind: "file", original_filename: "interview-notes.pdf" },
        { id: "s2", kind: "link", url: "https://example.com/platform-roadmap", original_filename: "Platform engineering roadmap" },
      ],
    },
    {
      id: "g2",
      title: "Run a marathon",
      status: "active",
      horizon: "long",
      why: "I want to feel fast again.",
      target_date: day(75),
      next_action: "Book the physio session",
      sources: [],
    },
    {
      id: "g3",
      title: "Ship the v2 landing page",
      status: "paused",
      horizon: "weekly",
      why: "It's the story I keep telling recruiters.",
      target_date: day(9),
      next_action: "Outline the five sections",
      sources: [],
    },
  ],
  milestones: [
    { id: "m1", goal_id: "g1", goal_title: "Switch into platform engineering", title: "Three informational calls", status: "open", target_date: day(12) },
    { id: "m2", goal_id: "g2", goal_title: "Run a marathon", title: "First 10k race", status: "open", target_date: day(6) },
    { id: "m3", goal_id: "g3", goal_title: "Ship the v2 landing page", title: "Copy approved", status: "done", target_date: day(-3) },
  ],
  blockers: [
    { id: "b1", title: "Conference week", start_date: day(3), end_date: day(5), note: "" },
  ],
  over_commitment: {
    level: "moderate",
    active_goals: 3,
    open_commitments: 0,
    message: "3 goals in play. Doable, but only one can lead this week.",
    conflicting: ["Run a marathon", "Switch into platform engineering"],
  },
};

// Served to the MotivationCard and TodayTimetable children on mount.
const motivation = {
  items: [
    {
      id: "rec_1",
      kind: "book",
      title: "Deep Work",
      author: "Cal Newport",
      duration: "6 min read",
      url: "https://calnewport.com/books/deep-work/",
      frame: "You've said the evening writing block keeps slipping — this is the shortest argument for defending it.",
    },
    {
      id: "rec_2",
      kind: "talk",
      title: "How to make hard choices",
      author: "Ruth Chang",
      duration: "14 min watch",
      url: "https://www.ted.com/talks/ruth_chang_how_to_make_hard_choices",
      frame: "Two goals are pulling at the same week. This reframes the trade-off as identity, not arithmetic.",
    },
  ],
};
const blockers = [{ id: "b1", title: "Conference week", start_date: day(3), end_date: day(5), note: "" }];

export default {
  title: "Components/TrackingDashboard",
  component: TrackingDashboard,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
    api: { "motivation/recommend": motivation, blockers, timetable: { blocks: [] } },
  },
  args: {
    state,
    onPrefill: fn(),
    onAction: fn(),
    onUploadSource: fn(),
    onAddLink: fn(),
    onDeleteSource: fn(),
    onCreated: fn(),
    onOpenChat: fn(),
    onOpenChatWith: fn(),
    autoAnswer: false,
    grillMe: false,
    isGuest: false,
  },
};

export const Default = {};
