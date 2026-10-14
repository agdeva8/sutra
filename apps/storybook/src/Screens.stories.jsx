/**
 * The app, screen by screen — the main folder of this Storybook.
 *
 * Each story renders `<AppShell>`: the same providers, routes and components as
 * `src/App.js`, with a seeded `MemoryRouter` instead of `BrowserRouter`.
 *
 * The router swap is not cosmetic. `App.js`'s catch-all route
 * (`<Route path="*" element={<Navigate to="/" replace/>}>`) rewrites the URL
 * whenever the path doesn't match, and inside Storybook's iframe the path is
 * `/iframe.html` — so the real `<App/>` navigates its own canvas away and the
 * story renders blank. A seeded `MemoryRouter` is the only way to show a real
 * screen in an iframe. See the note at the top of src/AppShell.jsx.
 *
 * Every screen talks to the mocked backend in src/mock/, so the app is live:
 * tick a task, confirm a proposal, send a chat turn and watch it stream.
 */
import { useEffect, useState } from "react";

import AppShell from "@/AppShell";
import { missingRoutes, onStoreChange } from "@/mock/backend";
import { store } from "@/mock/fixtures";
import { SCRATCH_OPENED_KEY } from "@/lib/scratchIntro";

/**
 * Status pill — bottom-left, away from the app's own bottom-right controls.
 *
 * It reports whether every endpoint the current screen asked for had a fixture.
 * That is the difference between "this panel is blank because the mock has no
 * data for it" and "this panel is blank because the UI is broken" — without it,
 * a mock gap reads as a bug. Press `b` to collapse, or ✕.
 */
function StatusPill() {
  const [missing, setMissing] = useState([]);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    const sync = () => setMissing([...missingRoutes]);
    const off = onStoreChange(sync);
    const t = setInterval(sync, 1000);
    return () => {
      off();
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "b" && !/input|textarea/i.test(e.target?.tagName || "")) setOpen((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const base = {
    position: "fixed",
    left: 12,
    bottom: 12,
    zIndex: 2147483000,
    font: "11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace",
    color: "var(--text-primary, #fff)",
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Mock status (b)"
        style={{
          ...base,
          width: 28,
          height: 28,
          borderRadius: 999,
          border: "1px solid var(--border, #38383A)",
          background: missing.length ? "var(--danger, #FF453A)" : "var(--bg-tertiary, #2C2C2E)",
          cursor: "pointer",
        }}
      >
        {missing.length || "i"}
      </button>
    );
  }

  return (
    <div
      style={{
        ...base,
        maxWidth: 340,
        padding: "10px 12px",
        borderRadius: 12,
        border: "1px solid var(--border, #38383A)",
        background: "var(--bg-secondary, #1C1C1E)",
        boxShadow: "0 8px 24px rgba(0,0,0,.45)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <strong style={{ fontWeight: 600 }}>Mock</strong>
        <button
          type="button"
          onClick={() => setOpen(false)}
          title="Collapse (b)"
          style={{
            marginLeft: "auto",
            background: "transparent",
            border: 0,
            color: "var(--text-muted, #98989D)",
            cursor: "pointer",
            font: "inherit",
          }}
        >
          ✕
        </button>
      </div>
      {missing.length === 0 ? (
        <div style={{ color: "var(--success, #30D158)" }}>All requested endpoints have fixtures.</div>
      ) : (
        <>
          <div style={{ color: "var(--danger, #FF453A)", marginBottom: 4 }}>
            No fixture for {missing.length} endpoint{missing.length === 1 ? "" : "s"} — blank areas
            are mock gaps, not UI bugs:
          </div>
          <ul style={{ margin: 0, paddingLeft: 16, color: "var(--text-secondary, #EBEBF5)" }}>
            {missing.slice(0, 8).map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export default {
  title: "App/Screens",
  component: AppShell,
  parameters: {
    // The app draws its own shell, header and fixed chat button.
    layout: "fullscreen",
    // Skip preview.jsx's MemoryRouter/Toaster — AppShell provides both, and
    // nesting one router inside another is a hard error in react-router.
    bare: true,
  },
  argTypes: {
    initialPath: { control: "text" },
  },
  decorators: [
    (Story) => (
      <>
        <Story />
        <StatusPill />
      </>
    ),
  ],
};

/** Overview — the default landing screen. */
export const Overview = { args: { initialPath: "/" } };
/** Phone width — shows the bottom tab bar (4 screens + More). */
export const OverviewMobile = {
  args: { initialPath: "/" },
  parameters: { viewport: { defaultViewport: "mobile1" } },
};

/**
 * The panel routes. `?panel=` is how Coach picks a screen
 * (see src/constants/screens.js), so seeding the path is all it takes.
 */
export const Plan = { args: { initialPath: "/?panel=plan" } };
export const Goals = { args: { initialPath: "/?panel=state" } };
/** Scratch — reflex capture, phone only (not in the desktop tab strip). Demo data, no API yet. */
export const ScratchMobile = {
  args: { initialPath: "/?panel=scratch" },
  parameters: { viewport: { defaultViewport: "mobile1" } },
};

/**
 * Phone landing (open "/" with no panel): the user has goals, so the app opens
 * on Scratch. Desktop would stay on Overview.
 */
export const LandingMobileWithGoals = {
  args: { initialPath: "/" },
  parameters: { viewport: { defaultViewport: "mobile1" } },
};

/**
 * A user with goals who has never opened Scratch: the screen blurs with a bright
 * ring and an arrow on the Scratch tab. "What can I do here?" opens the explainer;
 * the spotlight leaves only when the ring is tapped.
 */
export const ScratchIntroHint = {
  args: { initialPath: "/?panel=state" },
  parameters: { viewport: { defaultViewport: "mobile1" } },
  beforeEach: () => {
    try {
      localStorage.removeItem(SCRATCH_OPENED_KEY);
    } catch {
      /* storage blocked: the hint still shows */
    }
  },
};

/** The same spotlight on desktop web: the ring sits on the Scratch tab in the top strip and the message opens below it. */
export const ScratchIntroHintDesktop = {
  args: { initialPath: "/?panel=state" },
  beforeEach: ScratchIntroHint.beforeEach,
};

/** Phone landing with no goals: opens on the Goal screen, where a goal is added. */
export const LandingMobileNoGoals = {
  args: { initialPath: "/" },
  parameters: { viewport: { defaultViewport: "mobile1" } },
  beforeEach: () => {
    const goals = store.state.goals;
    store.state.goals = [];
    return () => {
      store.state.goals = goals;
    };
  },
};
export const Today = { args: { initialPath: "/?panel=today" } };
export const Timeline = { args: { initialPath: "/?panel=timeline" } };
export const Memories = { args: { initialPath: "/?panel=memories" } };
export const Sources = { args: { initialPath: "/?panel=sources" } };
export const Curated = { args: { initialPath: "/?panel=motivation" } };

/** Settings — model provider, account, audit log. */
export const Settings = { args: { initialPath: "/settings" } };
