import { fn, expect, userEvent } from "storybook/test";
import InstallPromptDialog from "./InstallPromptDialog";

// Module-level mocks (the SuccessBanner pattern in this repo): args reference
// them and play functions assert on them directly — canvas.args isn't
// available in this Storybook version's play context.
const onClose = fn();
const onInstall = fn();

export default {
  title: "Components/InstallPromptDialog",
  component: InstallPromptDialog,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  args: {
    open: true,
    platform: "chromium",
    onClose,
    onInstall,
    installing: false,
  },
};

/** Chromium (Chrome/Edge): the real beforeinstallprompt path — Install button replays the native prompt. */
export const ChromiumInstall = {
  play: async ({ canvas }) => {
    await expect(canvas.getByText("Install Sutra")).toBeInTheDocument();
    await expect(canvas.getByTestId("install-prompt-benefits")).toBeInTheDocument();
    await userEvent.click(canvas.getByTestId("install-prompt-install"));
    await expect(onInstall).toHaveBeenCalled();
  },
};

/** Tapping "Not now" dismisses (the container persists the 14-day snooze). */
export const ChromiumDismiss = {
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByTestId("install-prompt-dismiss"));
    await expect(onClose).toHaveBeenCalled();
  },
};

/** While the native install sheet is open the button is disabled so double-taps can't stack prompts. */
export const Installing = {
  args: { installing: true },
  play: async ({ canvas }) => {
    const btn = canvas.getByTestId("install-prompt-install");
    await expect(btn).toBeDisabled();
    await expect(btn).toHaveTextContent("Opening installer…");
  },
};

/** iOS Safari: no install event exists — this teaches Share → Add to Home Screen instead. */
export const IosManualSteps = {
  args: { platform: "ios" },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("install-prompt-ios-steps")).toBeInTheDocument();
    // No Install button on iOS — the capability genuinely isn't there.
    await expect(canvas.queryByTestId("install-prompt-install")).toBeNull();
    await expect(canvas.getByText("Add to Home Screen")).toBeInTheDocument();
    await userEvent.click(canvas.getByTestId("install-prompt-dismiss"));
    await expect(onClose).toHaveBeenCalled();
  },
};

/** Closed state: the container renders null, nothing mounts. */
export const Closed = {
  args: { open: false },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector('[role="dialog"]')).toBeNull();
  },
};
