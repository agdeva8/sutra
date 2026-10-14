import { expect, fn, userEvent } from "storybook/test";
import GoalIntakeDialog from "./GoalIntakeDialog";

/** Add a goal through agentv2's intake (the mock backend answers with a canned dialogue). */
export default {
  title: "Components/GoalIntakeDialog",
  component: GoalIntakeDialog,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen", viewport: { defaultViewport: "mobile1" } },
  args: { open: true, onClose: fn(), onCreated: fn() },
};

export const Default = {};

export const FromGoalToPlan = {
  play: async ({ canvas, args }) => {
    await userEvent.type(canvas.getByLabelText("Your goal"), "learn driving in 3 months{Enter}");
    await userEvent.click(await canvas.findByRole("button", { name: "Permit, no car" }));
    await expect(await canvas.findByTestId("goal-intake-draft")).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "Create and plan" }));
    await new Promise((r) => setTimeout(r, 300));
    await expect(args.onCreated).toHaveBeenCalled();
  },
};
