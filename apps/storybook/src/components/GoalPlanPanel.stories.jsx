import { fn } from "storybook/test";
import GoalPlanPanel from "./GoalPlanPanel";

/**
 * One goal's plan tree — the plan tree on its own.
 *
 * No `PLAN TREE / CALENDAR` toggle and no calendar: Timeline owns the
 * calendar, and this is what was worth keeping from the old Plan tab. It is
 * rendered in two places from this one definition — the Goal tab's side panel
 * (see `GoalBoard`) and the `?panel=plan` route (see `PlanWorkspace`).
 *
 * `onClose` is optional. Omit it and no close button renders, which is how the
 * `?panel=plan` route uses it: a full route is not an overlay and has nothing
 * to dismiss.
 */
export default {
  title: "Components/GoalPlanPanel",
  component: GoalPlanPanel,
  tags: ["autodocs"],
  args: {
    onChanged: fn(),
    onOpenChat: fn(),
    onClose: fn(),
  },
  decorators: [
    (Story) => (
      <div className="p-6 max-w-2xl bg-[var(--bg-primary)] text-[var(--text-primary)]">
        <Story />
      </div>
    ),
  ],
};

const goal = {
  id: "goal_run",
  title: "Run a half marathon under 2 hours",
  horizon: "monthly",
  status: "active",
  target_date: "2027-01-11",
  weekly_hours: 6,
};

const milestones = [
  { id: "ms_10k", goal_id: "goal_run", goal_title: goal.title, title: "Run 10k without walking", status: "open", target_date: "2026-10-19", phase: "base" },
  { id: "ms_base", goal_id: "goal_run", goal_title: goal.title, title: "Four weeks of consistent runs", status: "done", target_date: "2026-10-07", phase: "base" },
];

const nodes = [
  { id: "pi_6", level: "day", title: "Easy 5k", note: "0.75h", start_date: "2026-10-08", end_date: "2026-10-08", hours: 0.75, done: false },
  { id: "pi_7", level: "day", title: "Interval session", note: "1h", start_date: "2026-10-10", end_date: "2026-10-10", hours: 1, done: false },
  { id: "pi_8", level: "day", title: "Long run 12k", note: "1.5h", start_date: "2026-10-12", end_date: "2026-10-12", hours: 1.5, done: true },
];

/** A goal with milestones and tasks. */
export const Default = { args: { goal, milestones, nodes } };

/** Closable — how the Goal tab's side panel uses it. */
export const Closable = { args: { goal, milestones, nodes, onClose: fn() } };

/** A goal with milestones but no tasks yet. */
export const MilestonesOnly = { args: { goal, milestones, nodes: [] } };

/** A brand-new goal: neither milestones nor tasks. */
export const Empty = { args: { goal, milestones: [], nodes: [] } };
