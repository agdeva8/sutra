import { fn } from "storybook/test";
import Memories from "./Memories";

// GET /api/memories returns { memories: [...] }.
const memories = [
  {
    id: 1,
    kind: "photo",
    source_id: 101,
    caption: "Race day last spring — this is the feeling I'm training for.",
    created_at: "2026-09-12T08:30:00Z",
    goal_title: "Run a marathon",
  },
  {
    id: 2,
    kind: "photo",
    source_id: 102,
    caption: "Notebook page where the career-pivot plan started.",
    created_at: "2026-09-18T19:05:00Z",
    goal_title: "Switch into platform engineering",
  },
  {
    id: 3,
    kind: "photo",
    source_id: 103,
    caption: "The whiteboard after the first planning session.",
    created_at: "2026-09-26T11:45:00Z",
    goal_title: "Ship the v2 landing page",
  },
];

const state = {
  goals: [
    { id: "g1", title: "Run a marathon", status: "active" },
    { id: "g2", title: "Switch into platform engineering", status: "active" },
    { id: "g3", title: "Ship the v2 landing page", status: "paused" },
    { id: "g4", title: "Learn watercolour painting", status: "dropped" },
  ],
};

export default {
  title: "Components/Memories",
  component: Memories,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
    api: { memories: { memories } },
  },
  args: {
    state,
    onChange: fn(),
  },
};

export const Default = {};
