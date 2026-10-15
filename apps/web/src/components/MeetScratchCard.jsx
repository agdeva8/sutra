import { useState } from "react";
import { Sparkles } from "lucide-react";
import ScratchExamples from "./ScratchExamples";
import ScratchIntroDialog from "./ScratchIntroDialog";

/**
 * MeetScratchCard — Scratch introducing itself, inline, whenever Scratch is empty.
 *
 * The one-time spotlight (`ScratchSpotlight`) nudges a new user to open Scratch; this is what they find
 * once they are there, and what anyone finds again with an empty Scratch. It shows the idea in one line
 * and a picture of a thought becoming a plan item; "What can I do here?" opens the full tour.
 */
export default function MeetScratchCard() {
  const [tour, setTour] = useState(false);
  return (
    <div data-testid="meet-scratch-card" className="mt-3 rounded-2xl bg-[var(--bg-secondary)] p-4">
      <div className="flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-[var(--accent)]">
          <Sparkles className="h-4 w-4" aria-hidden="true" />
        </span>
        <h2 className="text-[16px] font-semibold text-[var(--text-primary)]">Meet Scratch</h2>
      </div>
      <p className="mt-2 text-[13px] leading-relaxed text-[var(--text-secondary)]">
        Dump a thought in three seconds. A reminder, a to-do, a meeting, a photo, or "done with the Q4 deck". We work out what it is and file it.
      </p>
      <div className="mt-3">
        <ScratchExamples />
      </div>
      <button
        type="button"
        onClick={() => setTour(true)}
        className="mt-3 text-[13px] font-medium text-[var(--accent)] hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] rounded"
      >
        What can I do here?
      </button>
      <ScratchIntroDialog open={tour} onClose={() => setTour(false)} onOpenScratch={() => setTour(false)} />
    </div>
  );
}
