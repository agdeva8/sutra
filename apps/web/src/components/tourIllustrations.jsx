/**
 * tourIllustrations — one small moving picture per first-run tour step.
 *
 * Each is inline SVG plus a CSS keyframe animation: no image files, no GIFs, and no new
 * dependency. Every illustration sits in a fixed 168×104 box so the card's height does not
 * jump between steps, and every animated node carries `tour-anim`, which the stylesheet
 * switches off under `prefers-reduced-motion` — the drawing then rests on the values written
 * in its markup, which is always a sensible still (all shapes present, nothing hidden
 * mid-transition).
 *
 * The SVGs are decorative: the card's line carries the meaning, so the whole box is
 * `aria-hidden`.
 */

/** The box every illustration is drawn in. Its aspect is fixed so the card never resizes between steps. */
const ART_W = 168;
const ART_H = 104;

/** How tall the illustration reads on a phone — inside the brief's 96–120px band. */
const ART_PHONE_H_PX = 104;

/**
 * The animations, named once. `!important` on the reduced-motion rule is deliberate: the
 * animation is set inline on each node, and only an important declaration beats inline style.
 */
const MOTION_CSS = `
.tour-art * { transform-box: fill-box; transform-origin: center; }

@keyframes tour-check {
  0%, 100% { opacity: 0.45; transform: scale(0.94); }
  45%, 72% { opacity: 1; transform: scale(1); }
}
@keyframes tour-node-fill {
  0%, 8% { fill: var(--bg-secondary); }
  26%, 86% { fill: var(--accent); }
  100% { fill: var(--bg-secondary); }
}
@keyframes tour-chip-pop {
  0%, 4% { opacity: 0; transform: scale(0.6); }
  16%, 88% { opacity: 1; transform: scale(1); }
  100% { opacity: 0; transform: scale(0.6); }
}
@keyframes tour-slide-in {
  0%, 100% { opacity: 0.25; transform: translate(-14px, 0); }
  28%, 82% { opacity: 1; transform: translate(0, 0); }
}
@keyframes tour-hop {
  0%, 8% { opacity: 0; transform: translate(0, 0); }
  18% { opacity: 1; }
  52% { transform: translate(46px, -24px); }
  78%, 88% { opacity: 1; transform: translate(74px, 6px); }
  100% { opacity: 0; transform: translate(74px, 6px); }
}
@keyframes tour-ring {
  0%, 8% { stroke-dashoffset: 126; }
  70%, 88% { stroke-dashoffset: 22; }
  100% { stroke-dashoffset: 126; }
}
@keyframes tour-underline {
  0%, 20% { transform: translateX(0); }
  38%, 58% { transform: translateX(40px); }
  76%, 100% { transform: translateX(80px); }
}
@keyframes tour-range-day {
  0%, 30% { opacity: 1; }
  36%, 100% { opacity: 0; }
}
@keyframes tour-range-week {
  0%, 32% { opacity: 0; }
  38%, 62% { opacity: 1; }
  68%, 100% { opacity: 0; }
}
@keyframes tour-range-month {
  0%, 66% { opacity: 0; }
  72%, 94% { opacity: 1; }
  100% { opacity: 0; }
}
@keyframes tour-fly {
  0%, 6% { opacity: 1; transform: translate(0, 0) rotate(-4deg); }
  62% { opacity: 1; transform: translate(58px, -34px) rotate(2deg); }
  78%, 100% { opacity: 0; transform: translate(70px, -42px) rotate(0deg); }
}
@keyframes tour-turn {
  0%, 100% { transform: scale(1); opacity: 0.55; }
  8%, 26% { transform: scale(1.14); opacity: 1; }
}
@keyframes tour-tick {
  0%, 10% { opacity: 0; transform: scale(0.4); }
  24%, 86% { opacity: 1; transform: scale(1); }
  100% { opacity: 0; transform: scale(0.4); }
}
@keyframes tour-flash {
  0%, 30% { opacity: 0; }
  38%, 52% { opacity: 0.85; }
  60%, 100% { opacity: 0; }
}

@media (prefers-reduced-motion: reduce) {
  .tour-anim { animation: none !important; }
}
`;

const muted = "var(--text-muted)";
const line = "var(--border)";
const paper = "var(--bg-primary)";
const accent = "var(--accent)";

/** Shared wrapper: fixes the box, mounts the stylesheet, and hides the art from assistive tech. */
function Art({ children }) {
  return (
    <div className="mb-3 flex items-center justify-center" aria-hidden="true" data-testid="first-run-tour-art">
      <style>{MOTION_CSS}</style>
      <svg
        viewBox={`0 0 ${ART_W} ${ART_H}`}
        width={ART_W}
        height={ART_PHONE_H_PX}
        fill="none"
        className="tour-art"
      >
        {children}
      </svg>
    </div>
  );
}

/** Sign in — a phone and a laptop showing the same plan, the check landing on both. */
function SignInArt() {
  return (
    <Art>
      <rect x="26" y="20" width="44" height="64" rx="9" stroke={muted} strokeWidth="2" />
      <rect x="33" y="28" width="30" height="46" rx="4" fill={paper} stroke={line} />
      <path
        className="tour-anim"
        style={{ animation: "tour-check 2.8s ease-in-out infinite" }}
        d="M40 51 l5 5 l11 -12"
        stroke={accent}
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="84" y="32" width="60" height="40" rx="4" stroke={muted} strokeWidth="2" />
      <path d="M74 82 h80" stroke={muted} strokeWidth="2" strokeLinecap="round" />
      <rect x="91" y="40" width="46" height="24" rx="3" fill={paper} stroke={line} />
      <path
        className="tour-anim"
        style={{ animation: "tour-check 2.8s ease-in-out infinite", animationDelay: "0.4s" }}
        d="M104 52 l5 5 l11 -12"
        stroke={accent}
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Art>
  );
}

/** Goal — one line splitting into three milestones, filling in one after the other. */
function GoalArt() {
  return (
    <Art>
      <path d="M18 52 H64" stroke={muted} strokeWidth="2" strokeLinecap="round" />
      <path d="M64 52 C 80 52 82 26 98 26" stroke={muted} strokeWidth="2" strokeLinecap="round" />
      <path d="M64 52 H98" stroke={muted} strokeWidth="2" strokeLinecap="round" />
      <path d="M64 52 C 80 52 82 78 98 78" stroke={muted} strokeWidth="2" strokeLinecap="round" />
      {[
        { cy: 26, delay: "0s" },
        { cy: 52, delay: "0.35s" },
        { cy: 78, delay: "0.7s" },
      ].map((dot) => (
        <circle
          key={dot.cy}
          className="tour-anim"
          style={{ animation: "tour-node-fill 3s ease-in-out infinite", animationDelay: dot.delay }}
          cx="104"
          cy={dot.cy}
          r="7"
          fill="var(--bg-secondary)"
          stroke={accent}
          strokeWidth="2"
        />
      ))}
    </Art>
  );
}

/** Add a goal — one sentence, then a link, a PDF and a photo sharpening it. */
function AddGoalArt() {
  return (
    <Art>
      <rect x="28" y="16" width="112" height="9" rx="4.5" fill={line} />
      <rect x="28" y="31" width="72" height="7" rx="3.5" fill={line} opacity="0.6" />
      {[
        { x: 27, delay: "0s" },
        { x: 65, delay: "0.35s" },
        { x: 103, delay: "0.7s" },
      ].map((chip) => (
        <rect
          key={chip.x}
          className="tour-anim"
          style={{ animation: "tour-chip-pop 3s ease-in-out infinite", animationDelay: chip.delay }}
          x={chip.x}
          y="54"
          width="34"
          height="30"
          rx="8"
          fill={paper}
          stroke={line}
        />
      ))}
      {/* link glyph */}
      <path
        className="tour-anim"
        style={{ animation: "tour-chip-pop 3s ease-in-out infinite" }}
        d="M37 73 a4 4 0 0 1 0-6 l4-4 M51 63 a4 4 0 0 1 0 6 l-4 4 M39 69 l10-6"
        stroke={accent}
        strokeWidth="2"
        strokeLinecap="round"
      />
      {/* PDF chip */}
      <g className="tour-anim" style={{ animation: "tour-chip-pop 3s ease-in-out infinite", animationDelay: "0.35s" }}>
        <text x="82" y="74" textAnchor="middle" fontSize="11" fontWeight="600" fill={accent}>
          PDF
        </text>
      </g>
      {/* photo glyph */}
      <g className="tour-anim" style={{ animation: "tour-chip-pop 3s ease-in-out infinite", animationDelay: "0.7s" }}>
        <rect x="111" y="62" width="18" height="14" rx="2.5" stroke={accent} strokeWidth="2" />
        <circle cx="116" cy="67" r="1.6" fill={accent} />
        <path d="M112 74 l5-5 3 3 3-3 4 5" stroke={accent} strokeWidth="2" strokeLinejoin="round" />
      </g>
    </Art>
  );
}

/** Timeline — a week grid whose blocks slide into their slots. */
function TimelineArt() {
  const cols = [30, 50, 70, 90, 110, 130, 150];
  const rows = [28, 46, 64, 82];
  const blocks = [
    { x: 30, y: 36, w: 18, h: 8, fill: accent, delay: "0s" },
    { x: 70, y: 54, w: 18, h: 8, fill: "color-mix(in srgb, var(--accent) 45%, transparent)", delay: "0.3s" },
    { x: 110, y: 38, w: 18, h: 8, fill: "var(--warning)", delay: "0.6s" },
    { x: 90, y: 73, w: 18, h: 8, fill: "var(--success)", delay: "0.9s" },
  ];
  return (
    <Art>
      {cols.map((x) => (
        <path key={x} d={`M${x} 18 V90`} stroke={line} strokeWidth="1.5" />
      ))}
      {rows.map((y) => (
        <path key={y} d={`M22 ${y} H158`} stroke={line} strokeWidth="1.5" />
      ))}
      {blocks.map((b) => (
        <rect
          key={`${b.x}-${b.y}`}
          className="tour-anim"
          style={{ animation: "tour-slide-in 3s ease-in-out infinite", animationDelay: b.delay }}
          x={b.x}
          y={b.y}
          width={b.w}
          height={b.h}
          rx="3"
          fill={b.fill}
        />
      ))}
    </Art>
  );
}

/** Sync calendar — a block leaving the grid and landing in a phone's calendar. */
function SyncCalendarArt() {
  return (
    <Art>
      <path d="M20 22 V82 M20 22 H74 M20 44 H74 M20 66 H74 M38 22 V82 M56 22 V82" stroke={line} strokeWidth="1.5" />
      <rect x="21" y="45" width="16" height="9" rx="3" fill="var(--warning)" opacity="0.7" />
      <rect x="39" y="23" width="16" height="9" rx="3" fill="var(--accent)" opacity="0.7" />
      <rect x="112" y="18" width="40" height="66" rx="8" stroke={muted} strokeWidth="2" />
      <rect x="118" y="30" width="28" height="6" rx="2" fill={line} />
      <path d="M118 46 H146 M118 58 H146 M118 70 H146" stroke={line} strokeWidth="1.5" />
      <rect
        className="tour-anim"
        style={{ animation: "tour-hop 3.2s ease-in-out infinite" }}
        x="40"
        y="25"
        width="16"
        height="9"
        rx="3"
        fill={accent}
      />
    </Art>
  );
}

/** Today — three range tabs with a progress ring filling. */
function TodayArt() {
  return (
    <Art>
      {[0, 1, 2].map((i) => (
        <rect key={i} x={30 + i * 40} y="14" width="28" height="5" rx="2.5" fill={line} />
      ))}
      <rect
        className="tour-anim"
        style={{ animation: "tour-underline 3.6s ease-in-out infinite" }}
        x="30"
        y="23"
        width="28"
        height="3"
        rx="1.5"
        fill={accent}
      />
      <circle cx="84" cy="62" r="20" stroke={line} strokeWidth="6" />
      <circle
        className="tour-anim"
        style={{ animation: "tour-ring 3.6s ease-in-out infinite" }}
        cx="84"
        cy="62"
        r="20"
        stroke={accent}
        strokeWidth="6"
        strokeLinecap="round"
        strokeDasharray="126"
        strokeDashoffset="126"
        transform="rotate(-90 84 62)"
      />
      <text x="84" y="66" textAnchor="middle" fontSize="11" fontWeight="600" fill={muted}>
        today
      </text>
    </Art>
  );
}

/** Range tabs — a day row widening into a week, then a month. */
function RangeArt() {
  /** A `cols` × `rows` grid of small day cells, starting at `top`. */
  const grid = (cols, rows, top, gap = 2) =>
    Array.from({ length: cols * rows }, (_, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      return (
        <rect
          key={`${col}-${row}`}
          x={24 + col * (16 + gap)}
          y={top + row * (12 + gap)}
          width="16"
          height="12"
          rx="2.5"
          fill={accent}
          opacity="0.45"
        />
      );
    });
  return (
    <Art>
      <g className="tour-anim" style={{ animation: "tour-range-day 3.6s ease-in-out infinite" }}>
        <rect x="24" y="44" width="120" height="14" rx="4" fill={accent} />
      </g>
      <g
        className="tour-anim"
        style={{ animation: "tour-range-week 3.6s ease-in-out infinite" }}
        opacity="0"
      >
        {Array.from({ length: 7 }, (_, i) => (
          <rect key={i} x={24 + i * 17.4} y="42" width="14" height="18" rx="3" fill={accent} opacity={0.55 + i * 0.05} />
        ))}
      </g>
      <g
        className="tour-anim"
        style={{ animation: "tour-range-month 3.6s ease-in-out infinite" }}
        opacity="0"
      >
        {grid(7, 4, 26)}
      </g>
    </Art>
  );
}

/** Scratch — a note flying into a filed card, tagged Task or Reminder. */
function ScratchNavArt() {
  return (
    <Art>
      <rect x="88" y="22" width="62" height="44" rx="8" fill={paper} stroke={accent} />
      <rect x="96" y="32" width="34" height="6" rx="3" fill={line} />
      <rect x="96" y="43" width="44" height="5" rx="2.5" fill={line} opacity="0.6" />
      <rect x="96" y="53" width="24" height="6" rx="3" fill="color-mix(in srgb, var(--accent) 22%, transparent)" />
      <text x="101" y="58" fontSize="6" fontWeight="600" fill={accent}>
        Task
      </text>
      <g className="tour-anim" style={{ animation: "tour-fly 3.2s ease-in-out infinite" }}>
        <rect x="22" y="66" width="34" height="26" rx="5" fill="var(--warning)" opacity="0.9" />
        <path d="M29 74 H49 M29 80 H44" stroke={paper} strokeWidth="2" strokeLinecap="round" />
      </g>
    </Art>
  );
}

/** Shared three-beat "each control takes its turn" animation. */
const turn = (delay) => ({
  animation: "tour-turn 3.6s ease-in-out infinite",
  animationDelay: delay,
});

/** Your Scratch pad — talk, snap or type; each takes its turn. */
function ScratchPadArt() {
  return (
    <Art>
      <g className="tour-anim" style={turn("0s")}>
        <rect x="20" y="42" width="16" height="22" rx="8" stroke={accent} strokeWidth="2" />
        <path d="M16 52 a12 12 0 0 0 24 0 M28 64 V72 M22 72 H34" stroke={accent} strokeWidth="2" strokeLinecap="round" />
      </g>
      <g className="tour-anim" style={turn("1.2s")}>
        <rect x="66" y="44" width="34" height="24" rx="5" stroke={accent} strokeWidth="2" />
        <circle cx="83" cy="56" r="6" stroke={accent} strokeWidth="2" />
        <path d="M72 44 l4-6 h14 l4 6" stroke={accent} strokeWidth="2" strokeLinejoin="round" />
        <rect
          className="tour-anim"
          style={{ animation: "tour-flash 3.6s ease-in-out infinite", animationDelay: "1.2s" }}
          x="62"
          y="36"
          width="42"
          height="34"
          rx="6"
          fill={accent}
          opacity="0"
        />
      </g>
      <g className="tour-anim" style={turn("2.4s")}>
        <rect x="112" y="52" width="44" height="20" rx="4" stroke={muted} strokeWidth="2" />
        {Array.from({ length: 5 }, (_, r) => (
          <g key={r}>
            {Array.from({ length: 8 }, (_, c) => (
              <rect key={c} x={116 + c * 5} y={56 + r * 3.5} width="3.5" height="2.5" rx="0.8" fill={line} />
            ))}
          </g>
        ))}
        <rect x="126" y="56" width="3.5" height="2.5" rx="0.8" fill={accent} />
      </g>
    </Art>
  );
}

/** To-dos — a checklist ticking itself off. */
function ToDosArt() {
  return (
    <Art>
      {[0, 1, 2].map((i) => (
        <g key={i}>
          <rect x="30" y={22 + i * 24} width="16" height="16" rx="4" stroke={muted} strokeWidth="2" />
          <rect x="54" y={27 + i * 24} width={86 - i * 14} height="6" rx="3" fill={line} />
          <path
            className="tour-anim"
            style={{ animation: "tour-tick 3.4s ease-in-out infinite", animationDelay: `${i * 0.5}s` }}
            d={`M34 ${30 + i * 24} l4 4 l8-9`}
            stroke={accent}
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
      ))}
    </Art>
  );
}

/**
 * The illustration for a step, or null for a step that shows a carousel instead (the
 * "Meet Scratch" dialog). Keyed by the same keys as `TOUR_STEPS`.
 */
const ART = {
  signin: SignInArt,
  goal_nav: GoalArt,
  goal_screen: AddGoalArt,
  timeline_nav: TimelineArt,
  timeline_screen: SyncCalendarArt,
  today_nav: TodayArt,
  today_screen: RangeArt,
  scratch_nav: ScratchNavArt,
  scratch_screen: ScratchPadArt,
  more_nav: ToDosArt,
};

export default function TourIllustration({ stepKey }) {
  const Drawing = ART[stepKey];
  return Drawing ? <Drawing /> : null;
}
