import { expect, fn, userEvent } from "storybook/test";
import ScratchIntroDialog from "./ScratchIntroDialog";

/** The tour shown from "What can I do here?" on the Scratch spotlight. */
export default {
  title: "Components/ScratchIntroDialog",
  component: ScratchIntroDialog,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen", viewport: { defaultViewport: "mobile1" } },
  args: { open: true, onClose: fn(), onOpenScratch: fn() },
};

export const Default = {};

export const OpensScratch = {
  play: async ({ canvas, args }) => {
    await userEvent.click(canvas.getByRole("button", { name: /Open Scratch/ }));
    await expect(args.onOpenScratch).toHaveBeenCalled();
  },
};

export const CanBeDismissed = {
  play: async ({ canvas, args }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Maybe later" }));
    await expect(args.onClose).toHaveBeenCalled();
  },
};
