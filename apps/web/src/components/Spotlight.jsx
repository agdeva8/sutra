import { useLayoutEffect, useState } from "react";

/**
 * The spotlight — a dark veil with a hole in it, a lit ring drawn in that hole, and
 * the measurement that keeps the hole over its target while the page moves under it.
 *
 * Shared by the first-run tour and the "Meet Scratch" spotlight, so the two can never
 * drift into looking like different apps.
 */

/** Space between the target's box and the ring's edge. */
export const RING_PAD_PX = 12;
/** How long to keep looking for a target that is not there yet. */
const LOOK_FOR_MS = 1000;
/** How often to look again while it is missing — a panel may still be fetching its chunk. */
const RELOOK_MS = 150;
const VEIL = "color-mix(in srgb, var(--bg-primary) 62%, transparent)";

/**
 * The visible box of the first selector that has one, or null. A hidden element —
 * `display:none`, or the nav belonging to the other width — measures zero, so one
 * list of selectors can cover the phone's bottom bar and the desktop's tab strip.
 */
export function findTarget(selectors) {
  for (const sel of selectors || []) {
    const r = document.querySelector(sel)?.getBoundingClientRect();
    if (r && r.width > 0 && r.height > 0) return r;
  }
  return null;
}

/** The ring's geometry around a target: padded, and round on a short target, pill-shaped on a long one. */
export function ringFor(rect) {
  const ring = {
    x: rect.left - RING_PAD_PX,
    y: rect.top - RING_PAD_PX,
    w: rect.width + RING_PAD_PX * 2,
    h: rect.height + RING_PAD_PX * 2,
  };
  return { ...ring, radius: Math.min(ring.w, ring.h) / 2 };
}

/**
 * A veil mask that is opaque everywhere except a rounded rectangle. Drawn as an SVG
 * path with the hole wound the other way (even-odd), so one rule covers the phone's
 * round ring and the desktop's pill.
 */
function holeMask(vw, vh, ring) {
  const { x, y, w, h, radius: r } = ring;
  const hole = `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${vw} ${vh}'><path fill-rule='evenodd' d='M0 0H${vw}V${vh}H0Z ${hole}'/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/**
 * Track a target's box while `active`. Re-measured on resize and on any scroll — the
 * app's panes scroll rather than the window, so the listener is a capturing one.
 *
 * A panel that is still fetching its chunk has not drawn its target yet, so a missing
 * one is looked for again for about a second before the caller settles for a card with
 * no ring on it. Past that, a resize or a scroll still picks a late target up.
 *
 * `selectors` must be a stable array (a module constant), not built during render.
 */
export function useTargetRect(selectors, active) {
  const [rect, setRect] = useState(null);
  useLayoutEffect(() => {
    if (!active) {
      setRect(null);
      return undefined;
    }
    const deadline = Date.now() + LOOK_FOR_MS;
    let retry = null;
    const measure = () => {
      const next = findTarget(selectors);
      setRect(next);
      if (!next && Date.now() < deadline) retry = setTimeout(measure, RELOOK_MS);
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      clearTimeout(retry);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [active, selectors]);
  return rect;
}

/**
 * The veil. With a ring it is cut away over the target and blurred elsewhere; without
 * one it simply covers the screen, which is the fallback when nothing could be found to
 * point at. Either way it swallows taps, so the only live thing is the card on top.
 */
export function SpotlightVeil({ ring }) {
  const mask = ring ? holeMask(window.innerWidth, window.innerHeight, ring) : null;
  return (
    <div
      aria-hidden="true"
      className="absolute inset-0 backdrop-blur-md"
      style={{
        background: VEIL,
        WebkitMaskImage: mask || undefined,
        maskImage: mask || undefined,
        WebkitMaskSize: mask ? "100% 100%" : undefined,
        maskSize: mask ? "100% 100%" : undefined,
      }}
    />
  );
}

/** The lit ring in the hole, with a pulse so it reads as "here". */
export function SpotlightRing({ ring, label, testId, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      data-testid={testId}
      className="absolute border-2 border-[var(--accent)] focus:outline-none focus-visible:ring-4 focus-visible:ring-[color-mix(in_srgb,var(--accent)_40%,transparent)]"
      style={{ left: ring.x, top: ring.y, width: ring.w, height: ring.h, borderRadius: ring.radius }}
    >
      <span
        aria-hidden="true"
        className="absolute inset-0 border-2 border-[var(--accent)] motion-safe:animate-ping"
        style={{ borderRadius: ring.radius }}
      />
    </button>
  );
}
