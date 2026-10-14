/**
 * SoonPill — the "this is not live yet" marker on a screen.
 *
 * One component rather than a hand-rolled span per surface (the mobile
 * GoalMenu, the desktop tab strip, the Curated screen's own card): the signal
 * has to read identically everywhere, and three copies would drift.
 *
 * Driven by `comingSoon` on the screen entry in constants/screens.js — the
 * nav draws it, so the flag and the marker never disagree about which screen
 * is unfinished.
 */
export default function SoonPill({ className = "" }) {
  return (
    <span
      data-testid="soon-pill"
      className={`font-mono text-[10px] uppercase tracking-widest leading-none whitespace-nowrap text-[var(--accent)] border border-[color-mix(in_srgb,var(--accent)_40%,transparent)] rounded-full px-1.5 py-0.5 ${className}`}
    >
      Soon
    </span>
  );
}
