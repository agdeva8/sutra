import { fn, expect } from "storybook/test";
import AskCard from "./AskCard";

/**
 * AskCard turns a coach `{ action: "ask" }` proposal into tappable
 * choices. Single-select sends on tap; multi-select toggles then sends
 * the set. With no options the card renders nothing.
 */
export default {
  title: "Components/AskCard",
  component: AskCard,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <div className="p-6 max-w-lg bg-[var(--bg-primary)] text-[var(--text-primary)]">
        <Story />
      </div>
    ),
  ],
};

/** Single-select — one tap answers immediately. */
export const SingleSelect = {
  args: {
    proposal: {
      id: "ask_1",
      action: "ask",
      args: {
        question: "Which goal should I focus on first?",
        options: ["Run a marathon", "Ship the landing page", "Learn Spanish"],
      },
    },
    onAnswer: fn(),
    busy: false,
  },
  play: async ({ canvas, args }) => {
    await canvas.getByTestId("ask-option-0").click();
    expect(args.onAnswer).toHaveBeenCalledWith("Run a marathon");
  },
};

/** Multi-select — tap to toggle, then send the whole set. */
export const MultiSelect = {
  args: {
    proposal: {
      id: "ask_2",
      action: "ask",
      args: {
        question: "Which parts should the plan cover?",
        multi: true,
        options: ["DSA / algorithms", "System design", "Behavioral", "Applications"],
      },
    },
    onAnswer: fn(),
    busy: false,
  },
  play: async ({ canvas, args }) => {
    await canvas.getByTestId("ask-option-0").click();
    await canvas.getByTestId("ask-option-2").click();
    await canvas.getByTestId("ask-send").click();
    expect(args.onAnswer).toHaveBeenCalledWith("DSA / algorithms, Behavioral");
  },
};

/** No options → the prose carries the question, so the card is null. */
export const NoOptions = {
  args: {
    proposal: { id: "ask_3", action: "ask", args: { question: "Anything else?" } },
    onAnswer: fn(),
    busy: false,
  },
  play: async ({ canvas }) => {
    expect(canvas.queryByTestId("ask-card")).toBeNull();
  },
};
