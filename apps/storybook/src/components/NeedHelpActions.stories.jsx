import { fn } from "storybook/test";
import NeedHelpActions from "./NeedHelpActions";

/**
 * The per-task "I can't do this" / "Break it down with the coach" pair.
 *
 * Extracted so the wording, the scoped-chat payloads and the dismissal
 * behaviour have one definition — the same pair now appears on the Today
 * timetable, the plan ladder's task rows and the Goal tab's plan panel.
 *
 * `prefix` namespaces the test ids so two of these on one screen stay
 * distinguishable.
 */
export default {
  title: "Components/NeedHelpActions",
  component: NeedHelpActions,
  tags: ["autodocs"],
  args: {
    item: { id: "pi_2", title: "Sketch the paywall screen" },
    onCant: fn(),
    onAddToPlan: fn(),
  },
  decorators: [
    (Story) => (
      <div className="p-6 max-w-xl bg-[var(--bg-primary)] text-[var(--text-primary)]">
        <Story />
      </div>
    ),
  ],
};

/** Closed — the resting state on a task row. */
export const Collapsed = {};

/** A task with a different label, as Today's timetable uses it. */
export const CustomLabel = {
  args: { label: "Stuck?", prefix: "timetable-today" },
};

/** A goal-level row rather than a task. */
export const GoalRow = {
  args: {
    item: { id: "goal_run", title: "Run a half marathon under 2 hours" },
    prefix: "plan-goal",
  },
};
