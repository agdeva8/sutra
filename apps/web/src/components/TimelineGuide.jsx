import { useEffect, useState } from "react";
import { ArrowRight, CalendarClock } from "lucide-react";
import { hasOpenedScratch, onScratchOpenedChange } from "../lib/scratchIntro";
import { hasSeenTimeline, markTimelineSeen, onTimelineSeenChange } from "../lib/timelineIntro";

/**
 * TimelineGuide — step two of the first-run guide: after the first goal, see the plan on the timeline.
 *
 * Not skippable, by design. Until the new user has looked at the timeline and pressed "Next", every
 * screen but the timeline sits behind a veil whose only way through is "Show my timeline"; on the
 * timeline a card at the bottom holds the next step. It only runs for someone who has a goal and has not
 * yet opened Scratch, so people already past the guide are left alone.
 */
export default function TimelineGuide({ goalCount, panelView, onShowTimeline }) {
  const [seen, setSeen] = useState(hasSeenTimeline);
  const [scratchOpened, setScratchOpened] = useState(hasOpenedScratch);
  useEffect(() => onTimelineSeenChange(() => setSeen(hasSeenTimeline())), []);
  useEffect(() => onScratchOpenedChange(() => setScratchOpened(hasOpenedScratch())), []);

  if (goalCount === 0 || seen || scratchOpened) return null;

  if (panelView === "timeline") {
    return (
      <div
        data-testid="timeline-guide-next"
        className="fixed inset-x-0 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] sm:bottom-6 z-[55] flex justify-center px-4 pointer-events-none"
      >
        <div className="pointer-events-auto w-full max-w-md rounded-2xl border border-[var(--accent)] bg-[var(--bg-secondary)] p-3 shadow-xl">
          <p className="text-[15px] font-semibold text-[var(--text-primary)]">That's your plan, laid out in time</p>
          <p className="mt-0.5 text-[13px] leading-snug text-[var(--text-secondary)]">Look around, then meet one more thing.</p>
          <button
            type="button"
            autoFocus
            onClick={markTimelineSeen}
            data-testid="timeline-guide-continue"
            className="mt-2.5 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-full bg-[var(--accent)] px-6 text-[15px] font-semibold text-white hover:opacity-90 focus:outline-none focus-visible:ring-4 focus-visible:ring-[color-mix(in_srgb,var(--accent)_40%,transparent)]"
          >
            Next: meet Scratch <ArrowRight className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div role="dialog" aria-modal="true" aria-label="See your timeline" data-testid="timeline-guide" className="fixed inset-0 z-[60]">
      <div aria-hidden="true" className="absolute inset-0 backdrop-blur-md" style={{ background: "color-mix(in srgb, var(--bg-primary) 62%, transparent)" }} />
      <div className="absolute inset-0 flex items-center justify-center px-5 pointer-events-none">
        <div className="pointer-events-auto w-full max-w-md rounded-2xl border border-[var(--accent)] bg-[var(--bg-secondary)] px-5 py-6 text-center shadow-xl">
          <span className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-[var(--accent)] text-white">
            <CalendarClock className="h-5 w-5" aria-hidden="true" />
          </span>
          <h2 className="text-[20px] font-semibold text-[var(--text-primary)]">Your plan is ready</h2>
          <p className="mt-2 text-[15px] leading-relaxed text-[var(--text-secondary)]">
            Your goal has been broken into steps and placed in your week. See it on your timeline.
          </p>
          <button
            type="button"
            autoFocus
            onClick={onShowTimeline}
            data-testid="timeline-guide-go"
            className="mt-5 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-[var(--accent)] px-6 text-[16px] font-semibold text-white hover:opacity-90 focus:outline-none focus-visible:ring-4 focus-visible:ring-[color-mix(in_srgb,var(--accent)_40%,transparent)]"
          >
            Show my timeline <ArrowRight className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}
