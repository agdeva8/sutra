import { fn } from "storybook/test";
import Overview from "./Overview";
import { AuthProvider } from "../context/AuthContext";
import { localDateKey } from "../lib/utils";

/**
 * Overview is the landing screen: a time-aware greeting, "Today at a
 * glance" (over-commitment + TrackerCard), and a goals preview. It reads
 * the user from AuthContext, so stories wrap in AuthProvider with the
 * auth endpoints stubbed.
 */
const day = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return localDateKey(d);
};

const commitments = [
  { id: "c1", text: "Easy 5k before work", due: day(0), status: "open", goal_id: "g1" },
];

export default {
  title: "Components/Overview",
  component: Overview,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
    api: {
      "auth/me": {
        user_id: "user_story01",
        name: "Devansh U. Agarwal",
        email: "dev@example.com",
        model_provider: "gemini",
      },
      "auth/guest": { user: { user_id: null, name: "Guest", is_guest: true } },
      blockers: [],
      commitments,
    },
  },
  decorators: [
    (Story) => (
      <AuthProvider>
        <Story />
      </AuthProvider>
    ),
  ],
  args: {
    state: {
      goals: [
        { id: "g1", title: "Run a marathon", status: "active", target_date: "2026-12-01" },
        { id: "g2", title: "Ship the v2 landing page", status: "active" },
      ],
      commitments,
      milestones: [],
      over_commitment: { over: false },
    },
    onOpenChat: fn(),
    onOpenToday: fn(),
    onOpenGoals: fn(),
  },
};

/** Greeting + Today at a glance + a goals preview. */
export const Default = {};

/** No goals yet → the preview becomes the "add your first goal" CTA. */
export const Empty = {
  args: { state: { goals: [], commitments: [], milestones: [] } },
};

/** `state` is null on first load → the skeleton (aria-busy) renders. */
export const Loading = {
  args: { state: null },
};
