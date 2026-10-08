import { fn } from "storybook/test";
import CalendarNestedView from "./CalendarNestedView";

/**
 * The nested-span calendar: one continuous bar per RANGE rather than one card
 * per day, with goals, their milestones and their tasks nesting by depth.
 *
 * This is Timeline's calendar, and the only one left — Plan's own month grid
 * was deleted. `unit` sets the column width, so the same component covers the
 * Day / Week / Month spans.
 *
 * `selectedGoalIds` filters to a subset; omit it and every goal shows.
 */
export default {
  title: "Components/CalendarNestedView",
  component: CalendarNestedView,
  tags: ["autodocs"],
  args: { onSelectItem: fn(), onSelectDay: fn() },
  decorators: [
    (Story) => (
      <div className="p-4 bg-[var(--bg-primary)] text-[var(--text-primary)]">
        <Story />
      </div>
    ),
  ],
};

const goals = [
  { id: "goal_mvp", title: "Ship the MVP to 10 paying users", start_date: "2026-10-01", target_date: "2026-12-07" },
  { id: "goal_run", title: "Run a half marathon under 2 hours", start_date: "2026-10-01", target_date: "2027-01-11" },
];

const milestones = [
  { id: "ms_spec", goal_id: "goal_mvp", goal_title: goals[0].title, title: "Draft the product spec", status: "open", target_date: "2026-10-05", phase: "build" },
  { id: "ms_ten", goal_id: "goal_mvp", goal_title: goals[0].title, title: "First 10 paying users", status: "open", target_date: "2026-10-28", phase: "launch" },
  { id: "ms_10k", goal_id: "goal_run", goal_title: goals[1].title, title: "Run 10k without walking", status: "open", target_date: "2026-10-19", phase: "base" },
];

const planItems = [
  { id: "pi_2", goal_id: "goal_mvp", title: "Sketch the paywall screen", status: "open", start_date: "2026-10-08", end_date: "2026-10-08" },
  { id: "pi_4", goal_id: "goal_mvp", title: "Interview 2 users", status: "open", start_date: "2026-10-09", end_date: "2026-10-09" },
  { id: "pi_6", goal_id: "goal_run", title: "Easy 5k", status: "open", start_date: "2026-10-08", end_date: "2026-10-08" },
  { id: "pi_8", goal_id: "goal_run", title: "Long run 12k", status: "open", start_date: "2026-10-12", end_date: "2026-10-12" },
];

const blockers = [
  { id: "blk_travel", title: "Family trip — no laptop", start_date: "2026-10-13", end_date: "2026-10-20" },
];

const month = { start: "2026-10-01", end: "2026-10-31" };

/** A month, day columns — the default span. */
export const Month = {
  args: { ...month, unit: "day", goals, milestones, planItems, blockers },
};

/** A month as week columns — coarser bars, fewer columns. */
export const MonthByWeek = {
  args: { ...month, unit: "week", goals, milestones, planItems, blockers },
};

/** A single week, day columns — the tightest useful span. */
export const Week = {
  args: { start: "2026-10-05", end: "2026-10-11", unit: "day", goals, milestones, planItems, blockers },
};

/** Filtered to one goal, the way Timeline's goal filter drives it. */
export const FilteredToOneGoal = {
  args: {
    ...month,
    unit: "day",
    goals,
    milestones,
    planItems,
    blockers,
    selectedGoalIds: new Set(["goal_run"]),
  },
};

/** A month with nothing planned — the empty grid. */
export const Empty = { args: { ...month, unit: "day", goals: [], milestones: [], planItems: [], blockers: [] } };
