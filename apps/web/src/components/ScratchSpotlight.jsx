import { useEffect, useState } from "react";
import { ArrowRight, PenLine, X } from "lucide-react";
import { hasOpenedScratch, markScratchOpened, onScratchOpenedChange } from "../lib/scratchIntro";
import ScratchIntroDialog from "./ScratchIntroDialog";
import { SpotlightRing, SpotlightVeil, ringFor, useTargetRect } from "./Spotlight";

/**
 * ScratchSpotlight — the first-goal nudge toward Scratch, and the whole guide.
 *
 * The first-run tour (components/FirstRunTour.jsx) has taken over the walk through the app, so Coach
 * no longer mounts this. It is kept, and kept working, because the shape it established — a dark veil
 * with one lit circle on the Scratch tab and a centred "Meet Scratch" card — is the look the tour
 * inherits; the veil, ring and measurement now come from components/Spotlight.jsx, shared by both.
 *
 * Once the user has a goal and has not opened Scratch, the app blurs behind a
 * dark veil with one bright circle on the Scratch tab and a centred "Meet Scratch" card. The
 * card's "Take me to Scratch" button (or the lit tab) opens Scratch and ends the spotlight.
 *
 * It has a close button: the veil covers every screen, so without one the app is
 * unusable until the user taps through. Closing hides it for the session — and, like
 * closing the tab, it returns next time until Scratch has been opened once. "What can
 * I do here?" opens the explainer.
 *
 * Works on phone and desktop: it points at whichever Scratch tab is on screen (the
 * bottom bar on a phone, the top strip on desktop) and puts the message on the
 * side with room, arrow included.
 */

/** The Scratch tab, wherever this width draws it: the phone's bottom bar, or the desktop strip. */
const TARGET_SELECTORS = ['[data-testid="mobile-tab-scratch"]', '[data-testid="panel-tab-scratch"]'];

export default function ScratchSpotlight({ goalCount, onOpenScratch }) {
  const [opened, setOpened] = useState(hasOpenedScratch);
  const [tourOpen, setTourOpen] = useState(false);
  useEffect(() => onScratchOpenedChange(() => setOpened(hasOpenedScratch())), []);

  // Dismissal is deliberately session-only (component state, not storage, next to
  // the ones `scratchIntro` owns): a close is "not now", not "never". A reload
  // brings it back, which is the same deal the tab-close route already had.
  const [dismissed, setDismissed] = useState(false);

  const active = goalCount > 0 && !opened && !dismissed;
  const rect = useTargetRect(TARGET_SELECTORS, active);

  const go = () => {
    markScratchOpened();
    setTourOpen(false);
    onOpenScratch();
  };

  if (!active) return null;

  // The explainer replaces the spotlight while it is open, then the spotlight returns.
  if (tourOpen) {
    return <ScratchIntroDialog open onClose={() => setTourOpen(false)} onOpenScratch={go} />;
  }
  if (!rect) return null;

  const ring = ringFor(rect);
  return (
    <div role="dialog" aria-modal="true" aria-label="Meet Scratch" data-testid="scratch-spotlight" className="fixed inset-0 z-[60]">
      {/* The veil: blurred and dimmed everywhere except a circle over the tab. It swallows taps. */}
      <SpotlightVeil ring={ring} />

      {/* The message, centred on every width, with its own way through. The ring on the tab stays lit
          so the user sees where Scratch lives. */}
      <div className="absolute inset-0 flex items-center justify-center px-5 pointer-events-none">
        <div className="pointer-events-auto relative w-full max-w-md rounded-2xl border border-[var(--accent)] bg-[var(--bg-secondary)] px-5 py-6 text-center shadow-xl">
          <button
            type="button"
            onClick={() => setDismissed(true)}
            aria-label="Close"
            data-testid="scratch-spotlight-close"
            className="absolute right-2 top-2 flex h-11 w-11 items-center justify-center rounded-full text-[var(--text-muted)] hover:text-[var(--text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
          <span className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-[var(--accent)] text-white">
            <PenLine className="h-5 w-5" aria-hidden="true" />
          </span>
          <h2 className="text-[20px] font-semibold text-[var(--text-primary)]">Meet Scratch</h2>
          <p className="mt-2 text-[15px] leading-relaxed text-[var(--text-secondary)]">
            Anything on your mind (a task, a photo, a quick voice note) goes into Scratch. We file it into your plan so you
            don't have to remember it.
          </p>
          <button
            type="button"
            autoFocus
            onClick={go}
            data-testid="scratch-spotlight-go"
            className="mt-5 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-[var(--accent)] px-6 text-[16px] font-semibold text-white hover:opacity-90 focus:outline-none focus-visible:ring-4 focus-visible:ring-[color-mix(in_srgb,var(--accent)_40%,transparent)]"
          >
            Take me to Scratch <ArrowRight className="h-5 w-5" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => setTourOpen(true)}
            className="mt-3 min-h-11 text-[14px] font-medium text-[var(--accent)] underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] rounded"
          >
            What can I do here?
          </button>
        </div>
      </div>

      {/* The ring, and the only way through. It sits exactly over the Scratch tab. */}
      <SpotlightRing ring={ring} label="Open Scratch" testId="scratch-spotlight-ring" onClick={go} />
    </div>
  );
}
