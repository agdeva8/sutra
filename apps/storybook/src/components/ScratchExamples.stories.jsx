import { expect, userEvent } from "storybook/test";
import ScratchExamples from "./ScratchExamples";

/** The auto-rotating "you dump this, it becomes that" carousel from the Scratch explainer. */
export default {
  title: "Components/ScratchExamples",
  component: ScratchExamples,
  tags: ["autodocs"],
  parameters: { viewport: { defaultViewport: "mobile1" } },
  decorators: [(Story) => <div className="mx-auto max-w-md p-4"><Story /></div>],
};

export const Default = {};

export const StepsWithArrows = {
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Next example" }));
    await expect(canvas.getByAltText("A photographed prescription")).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "Previous example" }));
    await expect(canvas.getByText(/boss gave me the Q4 deck/)).toBeInTheDocument();
  },
};
