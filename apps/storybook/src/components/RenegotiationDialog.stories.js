import { fn } from "storybook/test";
import RenegotiationDialog from "./RenegotiationDialog";

export default {
  title: "Components/RenegotiationDialog",
  component: RenegotiationDialog,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  args: {
    open: true,
    onClose: fn(),
    onChoose: fn(),
    options: [
      "shift_existing_target",
      "drop_existing_commitment",
      "extend_new_timeline",
      "reduce_new_hours",
    ],
    headroom: {
      decision: "renegotiate",
      budgetHours: 10,
      currentLoad: 10,
      newLoad: 7.5,
      total: 17.5,
      free: -7.5,
      unknownGoalCount: 0,
      message: "Overcommits by 7.5h (budget 10h, load 17.5h).",
    },
  },
};

export const OverBudget = {};

/** While an option is being re-planned, that row shows a spinner and all
 *  rows are disabled so the user can't fire a second choice. */
export const LoadingChoice = {
  args: { busyOption: "extend_new_timeline" },
};

/** When the server hasn't sent numbers, the dialog falls back to a generic
 *  subtitle rather than rendering "undefinedh". */
export const NoNumbers = {
  args: { headroom: null },
};
