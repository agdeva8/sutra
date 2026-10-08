import MotivationCard from "./MotivationCard";

/**
 * Motivation — its own tab (founder feedback). The curated
 * recommendation / nudge lives here rather than mixed into the Overview.
 * MotivationCard already hides itself when there's nothing to nudge
 * about, so this shell just provides the page frame + an empty state.
 */
export default function Motivation({ state }) {
  const goals = (state?.goals || []).filter((g) => g.status !== "dropped");

  return (
    <div data-testid="motivation-view" className="px-4 sm:px-6 py-5 sm:py-6 space-y-6 max-w-[820px] mx-auto w-full">
      <header>
        <p className="text-[14px] text-[var(--text-secondary)] leading-relaxed max-w-md">
          A nudge for right now, drawn from where you actually are.
        </p>
      </header>

      <MotivationCard state={state} />

      {goals.length === 0 && (
        <p className="text-[13px] text-[var(--text-muted)] leading-relaxed">
          Once you have a goal or two, the coach starts surfacing nudges tuned to what you're working on.
        </p>
      )}
    </div>
  );
}
