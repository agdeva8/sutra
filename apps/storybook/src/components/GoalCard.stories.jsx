import { fn } from "storybook/test";
import GoalCard from "./GoalCard";

/**
 * One editable goal, and its row of identity actions.
 *
 * The row is `plan · edit · pause · memories` then, pushed right, `drop`.
 * "Add a step / milestone" deliberately has no button: it duplicated "edit"
 * (both route to the same confirmation), so the row carries four distinct
 * actions rather than two that look different and do the same thing.
 */
export default {
  title: "Components/GoalCard",
  component: GoalCard,
  tags: ["autodocs"],
  args: {
    onAction: fn(),
    onAddMemory: fn(),
    onOpenPlan: fn(),
    onUploadSource: fn(),
    onAddLink: fn(),
    onDeleteSource: fn(),
  },
  decorators: [
    (Story) => (
      <div className="p-4 max-w-2xl bg-[var(--bg-primary)] text-[var(--text-primary)]">
        <div className="rounded-2xl bg-[var(--bg-secondary)] overflow-hidden">
          <Story />
        </div>
      </div>
    ),
  ],
};

const base = {
  id: "goal_run",
  title: "Run a half marathon under 2 hours",
  horizon: "monthly",
  status: "active",
  why: "I sit all day and it shows.",
  next_action: "Book the race entry",
  target_date: "2027-01-11",
};

const milestones = [
  { id: "ms_10k", goal_id: "goal_run", title: "Run 10k without walking", status: "open", target_date: "2026-10-19" },
  { id: "ms_base", goal_id: "goal_run", title: "Four weeks of consistent runs", status: "done", target_date: "2026-10-07" },
];

/** A full card: why, next action, milestones. */
export const Default = { args: { goal: base, milestones } };

/** No milestones yet — the chips are absent rather than empty. */
export const NoMilestones = { args: { goal: base, milestones: [] } };

/** Paused — a different status glyph. */
export const Paused = { args: { goal: { ...base, status: "paused" }, milestones } };

/** Minimal — no why, no next action, no target date. */
export const Bare = {
  args: { goal: { id: "goal_x", title: "Learn Spanish", status: "active" }, milestones: [] },
};
