import { useEffect, useState } from "react";

/**
 * Subscribes to a CSS media query and re-renders when it flips.
 *
 * Used by the mobile-first nav pass to swap horizontal nav/option rows
 * for their vertical or select-button equivalents below `sm:` — and to
 * keep ARIA orientation (Settings tabs) matching the visible layout.
 * The initial value is read synchronously so the first paint already
 * matches the viewport (no horizontal flash on mobile).
 */
export default function useMediaQuery(query) {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(query).matches
      : false,
  );

  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = (e) => setMatches(e.matches);
    setMatches(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}
