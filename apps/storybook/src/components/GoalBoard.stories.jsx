import { fn } from "storybook/test";
import GoalBoard from "./GoalBoard";

/**
 * The editable goal list, grouped by horizon.
 *
 * This is what the Goal tab renders under its tracker card: one `GoalCard` per
 * goal, carrying that goal's own actions, milestone chips and source chips.
 *
 * `state` is passed only so a goal's plan tree can be derived from its
 * `plan_items` when the plan panel opens — press any card's **plan** button to
 * see it, which is the interaction this board owns (only one plan open at a
 * time; opening a second replaces the first).
 */
export default {
  title: "Components/GoalBoard",
  component: GoalBoard,
  tags: ["autodocs"],
  args: {
    onAction: fn(),
    onUploadSource: fn(),
    onAddLink: fn(),
    onDeleteSource: fn(),
    onCreated: fn(),
    onChanged: fn(),
    onOpenChat: fn(),
  },
  decorators: [
    (Story) => (
      <div className="p-4 max-w-2xl bg-[var(--bg-primary)] text-[var(--text-primary)]">
        <Story />
      </div>
    ),
  ],
};

const goals = [
  {
    id: "goal_mvp",
    title: "Ship the MVP to 10 paying users",
    horizon: "quarterly",
    status: "active",
    why: "I want proof this is a real product before I quit my job.",
    next_action: "Write the onboarding checklist",
    target_date: "2026-12-07",
  },
  {
    id: "goal_run",
    title: "Run a half marathon under 2 hours",
    horizon: "monthly",
    status: "active",
    why: "I sit all day and it shows.",
    next_action: "Book the race entry",
    target_date: "2027-01-11",
  },
  {
    id: "goal_spanish",
    title: "Hold a 10-minute conversation in Spanish",
    horizon: "yearly",
    status: "paused",
    why: "Family trip next winter.",
    target_date: "2027-05-16",
  },
];

const milestones = [
  { id: "ms_spec", goal_id: "goal_mvp", title: "Draft the product spec", status: "open", target_date: "2026-10-05" },
  { id: "ms_ten", goal_id: "goal_mvp", title: "First 10 paying users", status: "open", target_date: "2026-10-28" },
  { id: "ms_10k", goal_id: "goal_run", title: "Run 10k without walking", status: "open", target_date: "2026-10-19" },
];

const plan_items = [
  { id: "pi_2", goal_id: "goal_run", horizon: "daily", title: "Easy 5k", status: "open", start_date: "2026-10-08", due_date: "2026-10-08", weekly_hours: 0.75 },
  { id: "pi_7", goal_id: "goal_run", horizon: "daily", title: "Interval session", status: "open", start_date: "2026-10-10", due_date: "2026-10-10", weekly_hours: 1 },
];

const state = { goals, milestones, plan_items };

/** Three goals across three horizons — the normal shape. */
export const Default = { args: { goals, milestones, state } };

/** One goal only. */
export const SingleGoal = {
  args: { goals: [goals[0]], milestones, state: { goals: [goals[0]], milestones, plan_items } },
};

/** Nothing tracked yet. */
export const Empty = { args: { goals: [], milestones: [], state: { goals: [], milestones: [], plan_items: [] } } };
