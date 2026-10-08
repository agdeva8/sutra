import { fn, expect } from "storybook/test";
import SuccessBanner from "./SuccessBanner";

const onView = fn();

export default {
  title: "Components/SuccessBanner",
  component: SuccessBanner,
  tags: ["autodocs"],
  args: {
    message: 'Created "Learn Spanish by December"',
    goalId: "goal_abc123",
    goalTitle: "Learn Spanish by December",
    createdAt: new Date("2026-10-01T09:30:00").toISOString(),
    onView,
  },
};

/** Banner with a goalId + view action — the full shape. */
export const Default = {
  play: async ({ canvas }) => {
    await canvas.getByTestId("success-banner-view").click();
    expect(onView).toHaveBeenCalled();
  },
};

/** No goalId → the view action is hidden. */
export const WithoutGoalId = {
  args: { goalId: undefined, goalTitle: undefined, onView: undefined },
  play: async ({ canvas }) => {
    expect(canvas.queryByTestId("success-banner-view")).toBeNull();
    expect(canvas.getByTestId("success-banner")).toBeInTheDocument();
  },
};

/** Long creation copy wraps without breaking the layout. */
export const WithLongMessage = {
  args: {
    message:
      'Created "Ship the operation-scoped context model for the Add Goal flow before the end of the quarter"',
  },
  play: async ({ canvas }) => {
    expect(canvas.getByTestId("success-banner")).toBeInTheDocument();
  },
};
