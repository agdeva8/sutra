import { useLayoutEffect } from "react";
import { fn } from "storybook/test";
import ReplanToast from "./ReplanToast";

/**
 * ReplanToast renders `null` and surfaces a once-per-day, dismissible
 * sonner toast when the state holds a time-sensitive re-plan signal
 * (drift, infeasible edit, blocker/timetable collision). The global
 * `<Toaster>` (preview.jsx) draws the toast — it appears bottom-right,
 * not in the story canvas.
 *
 * The `gc_replan_toast_date` localStorage guard is cleared before each
 * render so the toast can fire in the story.
 */
function ResetToastGuard({ children }) {
  useLayoutEffect(() => {
    try {
      localStorage.removeItem("gc_replan_toast_date");
    } catch {
      /* ignore */
    }
  }, []);
  return children;
}

export default {
  title: "Components/ReplanToast",
  component: ReplanToast,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <ResetToastGuard>
        <Story />
      </ResetToastGuard>
    ),
  ],
  args: {
    suggestions: [
      {
        id: "s1",
        trigger: "drift",
        message: "\u201cRun a marathon\u201d has slipped two weeks behind its milestones.",
      },
    ],
    onReplan: fn(),
  },
};

/** Drift signal → the warning toast fires with a Review plan action. */
export const Default = {};

/** A collision signal picks the calendar icon and its own message. */
export const TimetableCollision = {
  args: {
    suggestions: [
      {
        id: "s2",
        trigger: "timetable_collision",
        message: "Two goal-linked blocks overlap on Thursday evening.",
      },
    ],
  },
};

/** No suggestions → nothing fires. */
export const Empty = {
  args: { suggestions: [] },
};
