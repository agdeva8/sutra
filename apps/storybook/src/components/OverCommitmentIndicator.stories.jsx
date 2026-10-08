import OverCommitmentIndicator from "./OverCommitmentIndicator";

/**
 * The week's load read — one card, four levels.
 *
 * `oc` is `state.over_commitment`. It is null on a state that has never been
 * computed, and then this renders nothing rather than an empty box, so the
 * "Not computed" story is a real case rather than a contrived one.
 */
export default {
  title: "Components/OverCommitmentIndicator",
  component: OverCommitmentIndicator,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <div className="p-6 max-w-xl bg-[var(--bg-primary)] text-[var(--text-primary)]">
        <Story />
      </div>
    ),
  ],
};

const oc = (level, active_goals, message) => ({ level, active_goals, message });

/** Nothing tracked yet — the quietest state. */
export const Clear = { args: { oc: oc("clear", 0, "No active goals.") } };

/** A normal load. */
export const Moderate = { args: { oc: oc("moderate", 3, "3 active goals.") } };

/** Starting to strain. */
export const High = { args: { oc: oc("high", 5, "5 active goals — consider dropping one.") } };

/** Over-committed. */
export const Critical = { args: { oc: oc("critical", 8, "8 active goals — over-committed.") } };

/** State never computed it — renders nothing, by design. */
export const NotComputed = { args: { oc: null } };
