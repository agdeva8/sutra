import { fn } from "storybook/test";
import Sources from "./Sources";

// GET /api/sources returns a bare array.
const sources = [
  {
    id: 1,
    kind: "file",
    original_filename: "interview-notes.pdf",
    created_at: "2026-09-20T14:00:00Z",
    goal_id: "g1",
  },
  {
    id: 2,
    kind: "link",
    name: "Platform engineering roadmap",
    url: "https://example.com/platform-roadmap",
    created_at: "2026-09-22T09:30:00Z",
    goal_id: "g2",
  },
  {
    id: 3,
    kind: "file",
    original_filename: "race-plan-2026.pdf",
    created_at: "2026-09-25T18:10:00Z",
    goal_id: "",
  },
];

const state = {
  goals: [
    { id: "g1", title: "Switch into platform engineering", status: "active" },
    { id: "g2", title: "Ship the v2 landing page", status: "active" },
  ],
};

export default {
  title: "Components/Sources",
  component: Sources,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
    api: { sources },
  },
  args: {
    state,
    onChange: fn(),
  },
};

export const Default = {};
