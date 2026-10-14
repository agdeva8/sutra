import { Sparkles } from "lucide-react";
import MotivationCard from "./MotivationCard";
import SoonPill from "./SoonPill";

/**
 * Motivation — the "Curated for you" screen. Its own surface rather than a
 * block inside the Overview (founder feedback): the curated nudge answers
 * "what is worth doing right now", which is not the Overview's question.
 *
 * The feature has not shipped, so the screen renders the coming-soon card
 * instead of `<CuratedBody>`. Nothing below the flag is deleted. MotivationCard
 * already fetches /api/motivation/recommend, polls a background refresh and
 * hides itself when there is nothing worth nudging about — so turning the
 * feature on is flipping this one constant, not rebuilding the screen.
 */
const CURATED_IS_COMING_SOON = true;

const COMING_SOON_BODY =
  "We're still building this. For now, ask your coach for something to read or watch.";

export default function Motivation({ state }) {
  return (
    <div
      data-testid="motivation-view"
      className="px-4 sm:px-6 py-5 sm:py-6 space-y-6 max-w-[820px] mx-auto w-full"
    >
      <header>
        <p className="text-[14px] text-[var(--text-secondary)] leading-relaxed max-w-md">
          Things to read and watch, picked for you based on your goals.
        </p>
      </header>

      {CURATED_IS_COMING_SOON ? <ComingSoonCard /> : <CuratedBody state={state} />}
    </div>
  );
}

/**
 * CuratedBody — the real screen: the recommendations, plus the no-goals copy
 * for when the card hides itself. Split out of `Motivation` so the coming-soon
 * branch carries none of its state.
 */
function CuratedBody({ state }) {
  const goals = (state?.goals || []).filter((g) => g.status !== "dropped");

  return (
    <>
      <MotivationCard state={state} />

      {goals.length === 0 && (
        <p className="text-[13px] text-[var(--text-muted)] leading-relaxed">
          Add a goal or two and your coach will start suggesting things to read and watch.
        </p>
      )}
    </>
  );
}

/**
 * ComingSoonCard — the Curated screen's placeholder until the feature ships.
 *
 * Deliberately wears MotivationCard's own shell (the same border, accent-tinted
 * gradient and Sparkles header) so the screen still reads as the curated
 * surface rather than an empty or broken one. The card's eyebrow line — the
 * "Picked from what you're working on" kicker — is what the `Soon` pill
 * replaces; that pill is the whole signal, so there is no second banner.
 */
function ComingSoonCard() {
  return (
    <div
      data-testid="motivation-coming-soon"
      className="border border-[var(--border)] bg-gradient-to-br from-[color-mix(in_srgb,var(--accent)_10%,transparent)] via-[color-mix(in_srgb,var(--accent)_5%,transparent)] to-transparent rounded-xl overflow-hidden"
    >
      <div className="px-4 sm:px-5 py-3.5 flex items-center gap-2 border-b border-[var(--border)]">
        <Sparkles className="w-4 h-4 text-[var(--accent)]" aria-hidden="true" />
        <div className="flex-1 min-w-0 text-sm font-semibold text-[var(--text-primary)]">
          Curated for you
        </div>
        <SoonPill />
      </div>

      <p className="px-4 sm:px-5 py-3.5 text-sm text-[var(--text-secondary)] leading-relaxed">
        {COMING_SOON_BODY}
      </p>
    </div>
  );
}
