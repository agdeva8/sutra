/**
 * Playground glue: give memory photos something to show.
 *
 * `Memories.js` builds each thumbnail's `src` from
 * `${API}/sources/:id/download`. That is a browser resource load, not a
 * `fetch`, so the mock backend in ./backend.js cannot answer it and every photo
 * renders as a broken-image icon.
 *
 * Swapping the src for an inline SVG on `error` is the cheapest fix that keeps
 * the layout honest (a real box, real dimensions) without inventing image
 * bytes. It is wired into both surfaces — `src/main.jsx` for the dev server and
 * `.storybook/preview.jsx` for Storybook — so the two render the same thing.
 *
 * The one-off `404` in the console is expected: the request has to fail before
 * the handler can fire.
 */
const PLACEHOLDER_IMG =
  "data:image/svg+xml;charset=utf-8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">' +
      '<rect width="400" height="400" fill="#2C2C2E"/>' +
      '<rect x="24" y="24" width="352" height="352" fill="none" stroke="#38383A" stroke-width="4"/>' +
      '<circle cx="140" cy="150" r="26" fill="#98989D" opacity="0.55"/>' +
      '<path d="M96 288l72-72 56 56 48-48 72 72" fill="none" stroke="#98989D" stroke-width="10" ' +
      'stroke-linecap="round" stroke-linejoin="round" opacity="0.55"/>' +
      "</svg>",
  );

export function installImageFallback() {
  if (typeof window === "undefined" || window.__sutraImageFallback) return;
  window.__sutraImageFallback = true;

  window.addEventListener(
    "error",
    (e) => {
      const el = e.target;
      if (!el || el.tagName !== "IMG" || el.dataset.galleryPlaceholder) return;
      el.dataset.galleryPlaceholder = "1";
      el.src = PLACEHOLDER_IMG;
    },
    true, // image `error` doesn't bubble, but it does capture
  );
}
