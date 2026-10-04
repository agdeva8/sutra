import { MemoryRouter } from "react-router-dom";
import { Toaster } from "sonner";

// The app's global stylesheet: Tailwind, the warm Sutra CSS-variable theme
// (--bg-primary, --accent, …) and the `gc-*` utility classes. Without it
// every story would render unstyled.
import "../src/index.css";

/* -------------------------------------------------------------------------
 * Tiny fetch shim (hand-written on purpose — no msw, no nock, no new deps).
 *
 * A story opts in by declaring `parameters.api`, a map of
 *   "<path after /api/>" -> response body
 * e.g. `parameters: { api: { sources: [...] } }`.
 *
 * The map is swapped in by the decorator below right before the story
 * renders (decorators are parents, so this assignment always happens before
 * the component's own `useEffect`s run). Anything a story does not declare
 * — and every story that declares nothing — falls through to the real
 * `fetch`, so this only ever suppresses calls the gallery would otherwise
 * make to a backend that isn't running.
 * ---------------------------------------------------------------------- */
let activeApiRoutes = null;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body ?? null), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installFetchShim() {
  if (typeof window === "undefined" || window.__sutraFetchShim) return;
  window.__sutraFetchShim = true;

  const realFetch = window.fetch.bind(window);

  window.fetch = (input, init) => {
    const routes = activeApiRoutes;
    const url =
      typeof input === "string" ? input : input && input.url ? input.url : String(input);

    if (!routes || !/\/api\//.test(url)) return realFetch(input, init);

    const key = url.split("/api/")[1].split("?")[0].replace(/\/+$/, "");
    if (!(key in routes)) {
      // An opted-in story stays fully offline: no request leaves the page.
      return Promise.resolve(jsonResponse({ detail: `no story mock for /api/${key}` }, 404));
    }

    const value = typeof routes[key] === "function" ? routes[key](url, init) : routes[key];
    // A route may return a raw body, a Response, or a promise of either —
    // a promise that never settles is how a story pins a component in its
    // loading state.
    return Promise.resolve(value).then(
      (v) => (v instanceof Response ? v : jsonResponse(v)),
      (e) => jsonResponse({ detail: String((e && e.message) || e) }, 500),
    );
  };
}

installFetchShim();

/* ------------------------------------------------------------------------
 * Photo memories build their <img> src from `${API}/sources/:id/download`,
 * which cannot go through `fetch`. Rather than leave broken-image icons in
 * the gallery, swap any failed image for a neutral inline placeholder once.
 * --------------------------------------------------------------------- */
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

if (typeof window !== "undefined") {
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

/** @type { import('@storybook/react').Preview } */
const preview = {
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
  },
  // The app's theme is not a Storybook concern by itself: Coach.js/Header.js
  // flip it by toggling the `light` class on <html>, which re-defines every
  // CSS variable in index.css. Without that class all stories render with
  // dark tokens — even next to Storybook's own "light" UI-theme button, which
  // only repaints Storybook's chrome. This global drives the same class.
  globalTypes: {
    appTheme: {
      description: "App theme (mirrors the real app's light/dark toggle)",
      toolbar: {
        title: "App theme",
        dynamicTitle: true,
        items: [
          { value: "dark", title: "Dark" },
          { value: "light", title: "Light (app default)" },
        ],
      },
    },
  },
  initialGlobals: { appTheme: "light" },
  decorators: [
    (Story, context) => {
      // Parent renders before its children, so both assignments below are in
      // place before any component effect fires or reads them.
      activeApiRoutes = context.parameters.api || null;
      const isLight = context.globals.appTheme === "light";
      document.documentElement.classList.toggle("light", isLight);

      // Repaint the canvas the way the app's <body> does. Storybook's own
      // preview background is white and would show through every transparent
      // story surface. Set it on <body> directly rather than wrapping <Story/>
      // in a styled <div>: fullscreen layout leaves html/body/#storybook-root
      // without a definite height, and a wrapper's min-height doesn't add one —
      // it just perturbs the DOM chain for no benefit (height-dependent
      // stories like Calendar collapse either way; that's a known gap).
      document.body.style.background = "var(--bg-primary)";
      document.body.style.color = "var(--text-primary)";

      return (
        // Header and AuthCallback call `useNavigate`; a MemoryRouter gives
        // them a route context without mounting any routes (navigation then
        // leaves the story in place instead of blanking the canvas).
        <MemoryRouter>
          {/* sonner toasts are invisible without a <Toaster /> in the tree */}
          <Toaster
            theme={isLight ? "light" : "dark"}
            position="bottom-right"
            toastOptions={{
              style: { fontFamily: "JetBrains Mono, monospace", fontSize: "12px" },
            }}
          />
          <Story />
        </MemoryRouter>
      );
    },
  ],
};

export default preview;
