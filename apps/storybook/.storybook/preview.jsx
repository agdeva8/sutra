import { MemoryRouter } from "react-router-dom";
import { Toaster } from "sonner";

// The app's global stylesheet: Tailwind, the warm Sutra CSS-variable theme
// (--bg-primary, --accent, …) and the `gc-*` utility classes. Without it every
// story would render unstyled.
import "../src/index.css";

// Installs the in-page mock backend for every story. The main worktree's
// Storybook made each story opt in via `parameters.api`; here the app-level
// mock in src/mock/backend.js already answers every endpoint with a fixture,
// so stories render with data by default. (Storybook's iframe is a separate
// document from the playground, so this import is what wires it up there.)
import "../src/mock/backend";
import { installImageFallback } from "../src/mock/image-fallback";

// Memory photos load through <img>, which the fetch-level mock can't answer.
// Shared with src/main.jsx so the dev server and Storybook render identically.
installImageFallback();

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
  // CSS variable in index.css. Without that class all stories render with dark
  // tokens — even next to Storybook's own "light" UI-theme button, which only
  // repaints Storybook's chrome. This global drives the same class.
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
      const isLight = context.globals.appTheme === "light";
      document.documentElement.classList.toggle("light", isLight);

      // Repaint the canvas the way the app's <body> does. Storybook's own
      // preview background is white and would show through every transparent
      // story surface, so set it on <body> directly rather than wrapping
      // <Story/> in a styled div.
      document.body.style.background = "var(--bg-primary)";
      document.body.style.color = "var(--text-primary)";

      // The full-app story brings its own BrowserRouter and Toaster. Wrapping
      // it in the MemoryRouter below would nest a <Router> inside a <Router>,
      // which react-router throws on — so those stories opt out.
      if (context.parameters.bare) return <Story />;

      return (
        // Header and AuthCallback call `useNavigate`; a MemoryRouter gives them
        // a route context without mounting any routes.
        <MemoryRouter>
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
