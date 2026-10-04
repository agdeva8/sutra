import { fn, expect } from "storybook/test";
import NavigateCard from "./NavigateCard";

/**
 * NavigateCard renders a read-only `{ action: "navigate" }` proposal as
 * a single "take me there" button. The actual change happens on the
 * destination screen, not in chat.
 */
export default {
  title: "Components/NavigateCard",
  component: NavigateCard,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <div className="p-6 max-w-md bg-[var(--bg-primary)] text-[var(--text-primary)]">
        <Story />
      </div>
    ),
  ],
};

/** Default label comes from the target map. */
export const Default = {
  args: {
    proposal: { id: "nav_1", action: "navigate", args: { target: "add_goal" } },
    onNavigate: fn(),
    busy: false,
  },
  play: async ({ canvas, args }) => {
    await canvas.getByTestId("navigate-add_goal").click();
    expect(args.onNavigate).toHaveBeenCalledWith("add_goal");
  },
};

/** An explicit label overrides the default. */
export const CustomLabel = {
  args: {
    proposal: {
      id: "nav_2",
      action: "navigate",
      args: { target: "timeline", label: "Plan my week" },
    },
    onNavigate: fn(),
    busy: false,
  },
};

/** No target → nothing to navigate to, so the card is null. */
export const NoTarget = {
  args: {
    proposal: { id: "nav_3", action: "navigate", args: {} },
    onNavigate: fn(),
    busy: false,
  },
  play: async ({ canvas }) => {
    expect(canvas.queryByTestId("navigate-card")).toBeNull();
  },
};
