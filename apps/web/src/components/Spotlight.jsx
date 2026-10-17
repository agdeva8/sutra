import { useLayoutEffect, useState } from "react";

/**
 * The spotlight — a dimmed, lightly blurred veil with a hole in it, a rounded ring
 * drawn around that hole, and the measurement that keeps the hole over its target
 * while the page moves under it.
 *
 * Shared by the first-run tour and the "Meet Scratch" spotlight, so the two can never
 * drift into looking like different apps.
 *
 * The veil is built from four panels around the hole rather than a mask on
 * `backdrop-filter`: a masked backdrop blur is unreliable on mobile Safari, and the
 * panels also give each edge a real element to swallow taps with. Nothing covers the
 * hole itself, so the control underneath stays tappable.
 */

/** Space between the target's box and the ring's edge. */
export const RING_PAD_PX = 8;
/** The ring's corner radius — a rounded rectangle, never a pill or a circle. */
export const RING_RADIUS_PX = 16;
/** How long to keep looking for a target that is not there yet. */
const LOOK_FOR_MS = 1000;
/** How often to look again while it is missing — a panel may still be fetching its chunk. */
const RELOOK_MS = 150;

/**
 * The veil's look, named once: a dark dim plus a light blur.
 *
 * `pointer-events-auto` is load-bearing, not decoration: a caller lays the veil out under a
 * `pointer-events-none` root so that the hole shows the real control through it, and these
 * panels are then the only thing left to stop taps reaching the app behind.
 */
const VEIL_PANEL_CLASS = "pointer-events-auto absolute bg-black/40 backdrop-blur-[2px]";

/**
 * The first element that is actually on screen, or null. A hidden element —
 * `display:none`, or the nav belonging to the other width — measures zero, so one
 * list of selectors can cover the phone's bottom bar and the desktop's tab strip.
 *
 * The element itself is handed back, not just its box: the tour scrolls it into view and
 * listens for a tap on it, and both need the node.
 */
export function findTargetElement(selectors) {
  for (const sel of selectors || []) {
    const el = document.querySelector(sel);
    const r = el?.getBoundingClientRect();
    if (r && r.width > 0 && r.height > 0) return el;
  }
  return null;
}

/** The visible box of the first selector that has one, or null. */
export function findTarget(selectors) {
  return findTargetElement(selectors)?.getBoundingClientRect() || null;
}

/**
 * The ring's geometry around a target: padded, rounded, and clamped to the viewport
 * so a target touching an edge still gets a ring that fits on screen.
 */
export function ringFor(rect) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = Math.max(0, rect.left - RING_PAD_PX);
  const top = Math.max(0, rect.top - RING_PAD_PX);
  const right = Math.min(vw, rect.left + rect.width + RING_PAD_PX);
  const bottom = Math.min(vh, rect.top + rect.height + RING_PAD_PX);
  const w = Math.max(0, right - left);
  const h = Math.max(0, bottom - top);
  return { x: left, y: top, w, h, radius: Math.min(RING_RADIUS_PX, w / 2, h / 2) };
}

/**
 * Track a target's box while `active`, and hand back the element too. Re-measured on
 * resize and on any scroll — the app's panes scroll rather than the window, so the
 * listener is a capturing one.
 *
 * A panel that is still fetching its chunk has not drawn its target yet, so a missing
 * one is looked for again for about a second before the caller settles for a card with
 * no ring on it. Past that, a resize or a scroll still picks a late target up.
 *
 * `refreshToken` is the caller's "measure again now" — the first paint after a step
 * change lands with stale geometry, and a change to this value re-runs the measurement.
 *
 * `selectors` must be a stable array (a module constant), not built during render.
 */
export function useTarget(selectors, active, refreshToken) {
  const [target, setTarget] = useState({ rect: null, el: null });
  useLayoutEffect(() => {
    if (!active) {
      setTarget({ rect: null, el: null });
      return undefined;
    }
    const deadline = Date.now() + LOOK_FOR_MS;
    let retry = null;
    const measure = () => {
      const el = findTargetElement(selectors);
      setTarget({ rect: el ? el.getBoundingClientRect() : null, el });
      if (!el && Date.now() < deadline) retry = setTimeout(measure, RELOOK_MS);
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      clearTimeout(retry);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [active, selectors, refreshToken]);
  return target;
}

/** The box alone, for callers that only draw a ring around it. */
export function useTargetRect(selectors, active, refreshToken) {
  return useTarget(selectors, active, refreshToken).rect;
}

/**
 * The veil. With a ring it is four panels around the hole — top, bottom, left, right —
 * so nothing is drawn over the target and a tap there reaches the real control. Without
 * one it simply covers the screen, which is the fallback when nothing could be found to
 * point at. Either way the panels swallow taps, so the app behind is not live.
 */
export function SpotlightVeil({ ring }) {
  if (!ring) {
    return <div aria-hidden="true" data-testid="spotlight-veil" className={`inset-0 ${VEIL_PANEL_CLASS}`} />;
  }
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const { x, y, w, h } = ring;
  const panels = [
    { left: 0, top: 0, width: vw, height: y },
    { left: 0, top: y + h, width: vw, height: Math.max(0, vh - y - h) },
    { left: 0, top: y, width: x, height: h },
    { left: x + w, top: y, width: Math.max(0, vw - x - w), height: h },
  ];
  return (
    <>
      {panels.map((panel, i) => (
        <div
          key={i}
          aria-hidden="true"
          data-testid="spotlight-veil-panel"
          className={VEIL_PANEL_CLASS}
          style={panel}
        />
      ))}
    </>
  );
}

/**
 * The lit ring in the hole: a rounded rectangle with an accent edge and a soft glow.
 * Deliberately not interactive — the hole has to stay a hole, so the tap lands on the
 * real control underneath.
 */
export function SpotlightRing({ ring, testId = "first-run-tour-ring" }) {
  return (
    <div
      aria-hidden="true"
      data-testid={testId}
      className="pointer-events-none absolute"
      style={{
        left: ring.x,
        top: ring.y,
        width: ring.w,
        height: ring.h,
        borderRadius: ring.radius,
        border: "2px solid var(--accent)",
        boxShadow: "0 0 24px 6px color-mix(in srgb, var(--accent) 40%, transparent)",
      }}
    />
  );
}
