import { fn } from "storybook/test";
import GoalMemoryDialog from "./GoalMemoryDialog";

export default {
  title: "Components/GoalMemoryDialog",
  component: GoalMemoryDialog,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  args: {
    open: true,
    onClose: fn(),
    goalId: "g1",
    goalTitle: "Run a marathon",
    onSaved: fn(),
  },
};

export const Default = {};
