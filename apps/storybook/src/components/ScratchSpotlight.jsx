import { useEffect, useLayoutEffect, useState } from "react";
import { ArrowRight, PenLine } from "lucide-react";
import { hasOpenedScratch, markScratchOpened, onScratchOpenedChange } from "../lib/scratchIntro";
import ScratchIntroDialog from "./ScratchIntroDialog";

/**
 * ScratchSpotlight — the first-goal nudge toward Scratch.
 *
 * Once the user has a goal and has not opened Scratch, the app blurs behind a
 * dark veil with one bright circle on the Scratch tab and a centred "Meet Scratch" card. The
 * card's "Take me to Scratch" button (or the lit tab) opens Scratch and ends the spotlight. There is no close button on purpose, so the feature is
 * not missed; closing the app ends it for that session, and it returns next time
 * until Scratch has been opened once. "What can I do here?" opens the explainer.
 *
 * Works on phone and desktop: it points at whichever Scratch tab is on screen (the
 * bottom bar on a phone, the top strip on desktop) and puts the message on the
 * side with room, arrow included.
 */

/** The Scratch tab, wherever this width draws it: the phone's bottom bar, or the desktop strip. */
const TARGET_SELECTORS = ['[data-testid="mobile-tab-scratch"]', '[data-testid="panel-tab-scratch"]'];
/** Space between the tab and the ring's edge. */
const RING_PAD_PX = 12;
const VEIL = "color-mix(in srgb, var(--bg-primary) 62%, transparent)";

/** The visible Scratch tab's box, or null. A hidden tab (display:none) measures zero. */
function findTarget() {
  for (const sel of TARGET_SELECTORS) {
    const r = document.querySelector(sel)?.getBoundingClientRect();
    if (r && r.width > 0 && r.height > 0) return r;
  }
  return null;
}

/**
 * A veil mask that is opaque everywhere except a rounded rectangle. Drawn as an SVG
 * path with the hole wound the other way (even-odd), so one rule covers the phone's
 * round ring and the desktop's pill.
 */
function holeMask(vw, vh, x, y, w, h, r) {
  const hole = `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${vw} ${vh}'><path fill-rule='evenodd' d='M0 0H${vw}V${vh}H0Z ${hole}'/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

function useTargetRect(active) {
  const [rect, setRect] = useState(null);
  useLayoutEffect(() => {
    if (!active) return undefined;
    const measure = () => setRect(findTarget());
    measure();
    window.addEventListener("resize", measure);
    // The nav can settle after first paint (fonts, safe-area insets).
    const t = setTimeout(measure, 250);
    return () => {
      window.removeEventListener("resize", measure);
      clearTimeout(t);
    };
  }, [active]);
  return rect;
}

export default function ScratchSpotlight({ goalCount, onOpenScratch }) {
  const [opened, setOpened] = useState(hasOpenedScratch);
  const [tourOpen, setTourOpen] = useState(false);
  useEffect(() => onScratchOpenedChange(() => setOpened(hasOpenedScratch())), []);

  const active = goalCount > 0 && !opened;
  const rect = useTargetRect(active);

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

  const ring = {
    x: rect.left - RING_PAD_PX,
    y: rect.top - RING_PAD_PX,
    w: rect.width + RING_PAD_PX * 2,
    h: rect.height + RING_PAD_PX * 2,
  };
  const radius = Math.min(ring.w, ring.h) / 2;
  const mask = holeMask(window.innerWidth, window.innerHeight, ring.x, ring.y, ring.w, ring.h, radius);
  return (
    <div role="dialog" aria-modal="true" aria-label="Meet Scratch" data-testid="scratch-spotlight" className="fixed inset-0 z-[60]">
      {/* The veil: blurred and dimmed everywhere except a circle over the tab. It swallows taps. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 backdrop-blur-md"
        style={{ background: VEIL, WebkitMaskImage: mask, maskImage: mask, WebkitMaskSize: "100% 100%", maskSize: "100% 100%" }}
      />

      {/* The message, centred on every width, with its own way through. The ring on the tab stays lit
          so the user sees where Scratch lives. */}
      <div className="absolute inset-0 flex items-center justify-center px-5 pointer-events-none">
        <div className="pointer-events-auto w-full max-w-md rounded-2xl border border-[var(--accent)] bg-[var(--bg-secondary)] px-5 py-6 text-center shadow-xl">
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
      <button
        type="button"
        onClick={go}
        aria-label="Open Scratch"
        data-testid="scratch-spotlight-ring"
        className="absolute border-2 border-[var(--accent)] focus:outline-none focus-visible:ring-4 focus-visible:ring-[color-mix(in_srgb,var(--accent)_40%,transparent)]"
        style={{ left: ring.x, top: ring.y, width: ring.w, height: ring.h, borderRadius: radius }}
      >
        <span aria-hidden="true" className="absolute inset-0 border-2 border-[var(--accent)] motion-safe:animate-ping" style={{ borderRadius: radius }} />
      </button>
    </div>
  );
}
