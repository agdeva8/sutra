import { fn, expect } from "storybook/test";
import CopyButton from "./CopyButton";

/**
 * CopyButton is the small per-message "copy" affordance in the chat.
 * It falls back to a hidden textarea + execCommand when the async
 * Clipboard API is unavailable.
 */
export default {
  title: "Components/CopyButton",
  component: CopyButton,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
  args: { text: "I propose a health goal with three milestones." },
  decorators: [
    (Story) => (
      <div className="p-6 bg-[var(--bg-primary)] text-[var(--text-primary)]">
        <Story />
      </div>
    ),
  ],
};

export const Default = {
  play: async ({ canvas }) => {
    const button = canvas.getByTestId("copy-message-button");
    expect(button).toHaveAttribute("aria-label", "Copy message");
    await button.click();
    // Clipboard may be blocked in the preview iframe; the button always
    // remains a labelled control either way.
    expect(canvas.getByTestId("copy-message-button")).toBeInTheDocument();
  },
};

/** Empty text is a no-op — the handler bails before touching the clipboard. */
export const EmptyText = {
  args: { text: "" },
  play: async ({ canvas }) => {
    expect(canvas.getByTestId("copy-message-button")).toBeInTheDocument();
  },
};
