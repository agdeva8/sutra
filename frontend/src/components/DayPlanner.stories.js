import { fn } from "storybook/test";
import DayPlanner from "./DayPlanner";

// Local YYYY-MM-DD (matches the component's fmtDate — toISOString would be UTC).
const today = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
})();

/**
 * DayPlanner is the editable daily-timetable panel for a single day
 * (timetable blocks, blockers, commitments, read-only milestones). It
 * fetches `/api/timetable` on mount and renders inside a CenteredDialog;
 * with no `day` it renders nothing.
 */
export default {
  title: "Components/DayPlanner",
  component: DayPlanner,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
    api: {
      timetable: {
        blocks: [
          { id: "b1", label: "Deep work", kind: "focus", block_date: today, start_time: "09:00", end_time: "11:00", note: "" },
          { id: "b2", label: "Easy run", kind: "routine", block_date: today, start_time: "07:00", end_time: "07:45", note: "5k" },
        ],
      },
      blockers: [],
      commitments: [],
    },
  },
  args: {
    state: {
      goals: [{ id: "g1", title: "Run a marathon", status: "active" }],
      commitments: [
        { id: "c1", text: "Easy 5k before work", due: today, status: "open", goal_title: "Run a marathon", note: "" },
      ],
      blockers: [],
      milestones: [],
    },
    onChange: fn(),
    onClose: fn(),
  },
};

/** A day with blocks + a commitment. `day` is built in-render (a Date
 *  can't be passed as a serializable story arg). */
export const Default = {
  render: (args) => <DayPlanner {...args} day={new Date()} />,
};

/** `day` is null → the panel renders nothing. */
export const NoDay = {
  render: (args) => <DayPlanner {...args} day={null} />,
};
