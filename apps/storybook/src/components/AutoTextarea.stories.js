import { fn } from "storybook/test";
import AutoTextarea from "./AutoTextarea";

/**
 * AutoTextarea grows with its content (up to `maxRows`) instead of
 * scrolling horizontally or clipping. It forwards all normal
 * <textarea> props and adds `minRows` / `maxRows`.
 */
export default {
  title: "Components/AutoTextarea",
  component: AutoTextarea,
  tags: ["autodocs"],
  args: { value: "", onChange: fn(), placeholder: "Why this matters…" },
  decorators: [
    (Story) => (
      <div className="p-6 max-w-md bg-[var(--bg-primary)] text-[var(--text-primary)]">
        <Story />
      </div>
    ),
  ],
};

export const Default = {};

/** A long caption wraps onto several lines and grows the box. */
export const GrowsWithContent = {
  args: {
    value:
      "A long caption that wraps across several lines and grows the box instead of scrolling sideways or clipping the text.",
  },
};

/** Past `maxRows` the box stops growing and scrolls vertically. */
export const ClampedAtMaxRows = {
  args: {
    minRows: 2,
    maxRows: 3,
    value: "one\ntwo\nthree\nfour\nfive\nsix\nseven",
  },
};
