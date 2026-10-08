import { fn } from "storybook/test";
import GoalBoundaryConfirmDialog from "./GoalBoundaryConfirmDialog";

export default {
  title: "Components/GoalBoundaryConfirmDialog",
  component: GoalBoundaryConfirmDialog,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  args: {
    open: true,
    onClose: fn(),
    changeType: "added",
    sourceName: "interview-notes.pdf",
    affectedGoals: [
      {
        id: "g1",
        title: "Switch into platform engineering",
        reason: "This source fills the last evidence gap on the 'first three interviews' milestone.",
      },
      {
        id: "g2",
        title: "Ship the v2 landing page",
        reason: "The same file was the only evidence for a milestone here.",
      },
    ],
    onReplan: fn(),
    onKeep: fn(),
  },
};

export const Default = {};
