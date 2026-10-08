import { fn, expect } from "storybook/test";
import ReplanSuggestions from "./ReplanSuggestions";

/**
 * ReplanSuggestions is the deterministic, opt-in "you should re-plan"
 * banner fed by `state.replan_suggestions`. Each row opens the existing
 * review_progress chat; dismissal is per-session (not persisted).
 */
export default {
  title: "Components/ReplanSuggestions",
  component: ReplanSuggestions,
  tags: ["autodocs"],
  args: { active: true },
  decorators: [
    (Story) => (
      <div className="p-6 max-w-xl bg-[var(--bg-primary)] text-[var(--text-primary)]">
        <Story />
      </div>
    ),
  ],
};

const suggestions = [
  {
    id: "s1",
    trigger: "capacity_freed",
    message:
      "You freed 4h/week by dropping \u201cLearn Spanish\u201d. Re-plan your remaining goals to use that capacity?",
  },
  {
    id: "s2",
    trigger: "drift",
    message: "\u201cRun a marathon\u201d has slipped two weeks behind its milestones.",
  },
];

/** Multiple triggers, each with its own icon + Re-plan action. */
export const Default = {
  args: { suggestions, onReplan: fn() },
  play: async ({ canvas, args }) => {
    expect(canvas.getByTestId("replan-suggestions")).toBeInTheDocument();
    await canvas.getByTestId("replan-suggestion-action-drift").click();
    expect(args.onReplan).toHaveBeenCalled();
  },
};

/** Dismissing a row removes it from view for the session. */
export const Dismissable = {
  args: { suggestions, onReplan: fn() },
  play: async ({ canvas }) => {
    await canvas.getByTestId("replan-suggestion-dismiss-drift").click();
    expect(canvas.queryByTestId("replan-suggestion-drift")).toBeNull();
  },
};

/** No suggestions → renders nothing. */
export const Empty = {
  args: { suggestions: [], onReplan: fn() },
  play: async ({ canvas }) => {
    expect(canvas.queryByTestId("replan-suggestions")).toBeNull();
  },
};

/** `active={false}` suppresses the banner on screens it doesn't apply to. */
export const Inactive = {
  args: { suggestions, onReplan: fn(), active: false },
  play: async ({ canvas }) => {
    expect(canvas.queryByTestId("replan-suggestions")).toBeNull();
  },
};
