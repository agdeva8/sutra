import { useLayoutEffect, useRef } from "react";

/**
 * AutoTextarea — a textarea that wraps and grows with its content
 * instead of scrolling horizontally or clipping.
 *
 * Founder feedback: the "Why this memory matters" field was a single-line
 * `<input>`, so a long caption scrolled sideways. Textareas wrap by
 * default; this adds the auto-grow so the box extends (up to `maxRows`)
 * and only then scrolls vertically.
 *
 * Props: same as a normal <textarea>, plus:
 *   minRows (default 2) — floor height in rows.
 *   maxRows (default 6) — ceiling before it scrolls.
 */
export default function AutoTextarea({
  value,
  minRows = 2,
  maxRows = 6,
  className = "",
  style,
  ...rest
}) {
  const ref = useRef(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Reset so scrollHeight reflects the content, then clamp.
    el.style.height = "auto";
    const lineHeight = 22; // matches leading-[22px]
    const pad = 16; // vertical padding (py-2)
    const min = minRows * lineHeight + pad;
    const max = maxRows * lineHeight + pad;
    const next = Math.min(max, Math.max(min, el.scrollHeight));
    el.style.height = `${next}px`;
  }, [value, minRows, maxRows]);

  return (
    <textarea
      ref={ref}
      value={value}
      rows={minRows}
      className={`resize-none overflow-y-auto ${className}`}
      style={{ minHeight: minRows * 22 + 16, maxHeight: maxRows * 22 + 16, ...style }}
      {...rest}
    />
  );
}
