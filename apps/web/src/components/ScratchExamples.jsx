import { useEffect, useRef, useState } from "react";
import { ArrowDown, Camera, ChevronLeft, ChevronRight, Mic, PenLine } from "lucide-react";

/**
 * ScratchExamples — a small carousel of "you dump this, it becomes that".
 *
 * Auto-rotates every `ROTATE_MS`, and stops for good the moment the user takes over with an arrow, the
 * dots or a swipe. Until then it holds still while they are touching, hovering or focused inside it, and
 * starts again when they leave. It does not rotate at all for users who prefer reduced motion. Purely
 * illustrative: the examples are fixed copy, not the user's data.
 */

const ROTATE_MS = 3000;
/** A drag this far sideways — and clearly more sideways than up or down — is a swipe, not a scroll. */
const SWIPE_MIN_PX = 40;

/** Bar heights (0-1) for the voice example's waveform: fixed, so it looks the same each time. */
const WAVE = [0.3, 0.55, 0.4, 0.8, 0.6, 0.35, 0.9, 0.7, 0.45, 0.6, 1, 0.75, 0.5, 0.85, 0.4, 0.65, 0.3, 0.7, 0.9, 0.55, 0.35, 0.6, 0.8, 0.45, 0.3, 0.5, 0.25];
const WAVE_STAGGER_S = 0.06;

/** `input` is what the user dumps: text, a photo (a file under /public), or a voice note with its transcript. */
const EXAMPLES = [
  {
    input: { type: "text", text: "boss gave me the Q4 deck, needs to be out before offsite" },
    kind: "New task",
    lines: ["Q4 deck · about 3 hours", "Planned Thursday, 9:00 to 12:00 · Career"],
  },
  {
    input: { type: "photo", src: "/scratch-examples/prescription.jpg", alt: "A photographed prescription" },
    kind: "Reminders + kept in Sources",
    lines: ["Azithromycin once a day for 3 days", "Paracetamol twice a day for 2 days"],
  },
  {
    input: {
      type: "voice",
      seconds: 8,
      transcript: "remind me to read about system design for the Google prep, like two hours this week",
    },
    kind: "New task",
    lines: ["Read about system design · 2 hours", "Planned Wednesday, 20:00 to 22:00 · Google prep"],
  },
  {
    input: { type: "photo", src: "/scratch-examples/whiteboard.jpg", alt: "A photographed meeting whiteboard" },
    kind: "3 tasks + kept in Sources",
    lines: ["Shortlist 3 offsite venues by Friday", "Draft the agenda", "The whiteboard, saved with a summary"],
  },
  {
    input: { type: "text", text: "dentist thursday 4pm" },
    kind: "Fixed in your day",
    lines: ["Dentist · Thursday, 16:00 to 17:00", "Nothing else gets planned over it"],
  },
  {
    input: { type: "text", text: "done with the Q4 deck" },
    kind: "Marked done",
    lines: ["Q4 deck ticked off your plan", "The time set aside for it is cleared"],
  },
];

const VIA_ICON = { text: PenLine, photo: Camera, voice: Mic };
const VIA_NAME = { text: "Typed note", photo: "Photo", voice: "Voice note" };

/** The dark mat behind a photo. The whole photo is shown, never cropped, so a portrait page stays a
 *  portrait page; a fixed height keeps the carousel steady between photo and other examples. */
const PHOTO_MAT = "bg-neutral-900";

const INPUT_BOX = "rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] shadow-sm";

function Dumped({ input }) {
  if (input.type === "photo") {
    return (
      <div className={`${INPUT_BOX} flex h-64 items-center justify-center overflow-hidden ${PHOTO_MAT}`}>
        <img src={input.src} alt={input.alt} loading="lazy" className="h-full w-auto max-w-full object-contain" />
      </div>
    );
  }
  if (input.type === "voice") {
    const mm = `0:${String(input.seconds).padStart(2, "0")}`;
    return (
      <div className={`${INPUT_BOX} px-3 py-2.5`}>
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-white">
            <Mic className="h-4 w-4" aria-hidden="true" />
          </span>
          <div aria-hidden="true" className="flex h-8 min-w-0 flex-1 items-center gap-[3px]">
            {WAVE.map((h, i) => (
              <span
                key={i}
                className="w-[3px] shrink-0 rounded-full bg-[var(--accent)] motion-safe:animate-pulse"
                style={{ height: `${Math.round(h * 100)}%`, animationDelay: `${(i * WAVE_STAGGER_S).toFixed(2)}s` }}
              />
            ))}
          </div>
          <span className="shrink-0 text-[12px] tabular-nums text-[var(--text-muted)]">{mm}</span>
        </div>
        <p className="mt-2 text-[12px] italic leading-snug text-[var(--text-muted)] [overflow-wrap:anywhere]">“{input.transcript}”</p>
      </div>
    );
  }
  return <div className={`${INPUT_BOX} px-3 py-2.5 text-[14px] text-[var(--text-primary)] [overflow-wrap:anywhere]`}>{input.text}</div>;
}

export default function ScratchExamples() {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  // Using the arrows, the dots or a swipe means "I'm reading": stop rotating for good.
  const taken = useRef(false);
  // Where the finger went down, so the lift can tell a swipe from a tap or a scroll.
  const touchStart = useRef(null);
  const reduced = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const auto = !paused && !taken.current && !reduced;

  useEffect(() => {
    if (!auto) return undefined;
    const t = setInterval(() => setIndex((i) => (i + 1) % EXAMPLES.length), ROTATE_MS);
    return () => clearInterval(t);
  }, [auto, index]);

  const go = (next) => {
    taken.current = true;
    setIndex((next + EXAMPLES.length) % EXAMPLES.length);
  };

  const onTouchStart = (e) => {
    const t = e.touches[0];
    touchStart.current = t ? { x: t.clientX, y: t.clientY } : null;
    setPaused(true);
  };

  const onTouchEnd = (e) => {
    setPaused(false);
    const from = touchStart.current;
    touchStart.current = null;
    const t = e.changedTouches[0];
    if (!from || !t) return;
    const dx = t.clientX - from.x;
    const dy = t.clientY - from.y;
    // Sideways and far enough: a swipe. Anything else (a tap, a vertical scroll) is left alone.
    if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) <= Math.abs(dy)) return;
    go(index + (dx < 0 ? 1 : -1));
  };

  const ex = EXAMPLES[index];
  const Via = VIA_ICON[ex.input.type];

  return (
    <section
      aria-roledescription="carousel"
      aria-label="Examples of what Scratch does"
      data-testid="scratch-examples"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
      className="rounded-2xl border border-[var(--border)] bg-gradient-to-br from-[color-mix(in_srgb,var(--accent)_14%,transparent)] via-[color-mix(in_srgb,var(--accent)_5%,transparent)] to-transparent p-3"
    >
      {/* The two arrows are the full height of the carousel's edges, not just the glyph — a 44px zone
          down each side is what a thumb actually aims at. `items-stretch` gives them that height. */}
      <div className="flex items-stretch gap-1.5">
        <button
          type="button"
          onClick={() => go(index - 1)}
          aria-label="Previous example"
          className="flex w-11 shrink-0 items-center justify-center rounded-xl text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          <ChevronLeft className="h-5 w-5" aria-hidden="true" />
        </button>

        {/* aria-live is off while it rotates by itself so a screen reader is not interrupted. */}
        <div key={index} aria-live={auto ? "off" : "polite"} className="gc-fade-in min-w-0 flex-1">
          <p className="sr-only">{VIA_NAME[ex.input.type]}</p>
          <div className="relative">
            <Dumped input={ex.input} />
            <span aria-hidden="true" className="absolute -top-2 left-2 flex h-5 w-5 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--accent)]">
              <Via className="h-3 w-3" />
            </span>
          </div>
          <div className="my-1.5 flex justify-center text-[var(--accent)]">
            <ArrowDown className="h-4 w-4" aria-hidden="true" />
          </div>
          <div className="min-h-[5.5rem] rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2.5">
            <p className="text-[11px] uppercase tracking-wider text-[var(--text-muted)]">{ex.kind}</p>
            {ex.lines.map((l) => (
              <p key={l} className="text-[13px] leading-snug text-[var(--text-primary)] [overflow-wrap:anywhere]">
                {l}
              </p>
            ))}
          </div>
        </div>

        <button
          type="button"
          onClick={() => go(index + 1)}
          aria-label="Next example"
          className="flex w-11 shrink-0 items-center justify-center rounded-xl text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          <ChevronRight className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>

      <div className="mt-2 flex justify-center gap-1.5" role="tablist" aria-label="Choose an example">
        {EXAMPLES.map((e, i) => (
          <button
            key={i}
            type="button"
            role="tab"
            aria-selected={i === index}
            aria-label={`Example ${i + 1} of ${EXAMPLES.length}`}
            onClick={() => go(i)}
            className={`h-1.5 rounded-full transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
              i === index ? "w-5 bg-[var(--accent)]" : "w-1.5 bg-[var(--border-accent)]"
            }`}
          />
        ))}
      </div>
    </section>
  );
}
