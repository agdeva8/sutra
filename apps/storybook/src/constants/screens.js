import {
  LayoutDashboard,
  Sparkles,
  Target,
  Flag,
  CalendarDays,
  CalendarClock,
  Image as ImageIcon,
  FileText,
} from "lucide-react";

/**
 * The Coach screens — one entry per distinct URL.
 *
 * Shared by the desktop tab strip (Coach.js), the GoalMenu dropdown, and
 * the mobile large-title bar, so labels, icons and destinations can never
 * drift apart. **This is the only screen list in the app** — a panel that
 * renders its own nav draws a second, competing strip (see the note at the
 * top of components/PlanWorkspace.jsx).
 *
 * Routing note: `/` is the **Home** screen — the canonical landing — and
 * the other screens ride on `?panel=<key>` instead of their own pathname.
 * Coach.js is keyed by `location.pathname` (see App.js' ViewTransition
 * comment), so keeping the pathname constant across panel switches
 * guarantees the page never remounts: chat, dashboard data and scroll
 * survive every switch, and browser/system back still steps
 * screen-by-screen because each switch is a history push.
 *
 * Six screens, one per tab, in this order:
 *   - **Overview** — the landing: greeting, today at a glance, and a
 *     read-only preview of the goals that links through to Goal.
 *   - **Today** — the day's timetable.
 *   - **Goal** — where goals are read and edited (the horizon-grouped board,
 *     each card carrying its own actions) and where the plan opens from.
 *   - **Timeline** — the calendar's Day → Year zoom surface.
 *   - **Memories** / **Sources** — the coach's material for the goals.
 *
 * Plan and Curated no longer own tabs. Neither is deleted: both stay
 * routable through ROUTABLE_SCREENS and Coach's panel switch, so an old
 * link or a chat "take me there" still lands on them.
 */
export const SCREENS = [
  { key: "home", label: "Overview", to: "/", Icon: LayoutDashboard },
  { key: "today", label: "Today", to: "/?panel=today", Icon: CalendarDays },
  { key: "state", label: "Goal", to: "/?panel=state", Icon: Flag },
  { key: "timeline", label: "Timeline", to: "/?panel=timeline", Icon: CalendarClock },
  { key: "memories", label: "Memories", to: "/?panel=memories", Icon: ImageIcon },
  { key: "sources", label: "Sources", to: "/?panel=sources", Icon: FileText },
];

/**
 * Every routable screen — the lookup `?panel=` resolves through.
 *
 * `SCREENS` is what the nav draws; this adds the keys that still exist in
 * URLs people already hold (a bookmark, a "Take me there" link from the
 * chat, a browser-history entry) but no longer own a tab. They carry no
 * `supersededBy`, so they render their own panel rather than bouncing
 * somewhere else — the content is still there, it just has no tab.
 */
export const ROUTABLE_SCREENS = [
  ...SCREENS,
  { key: "plan", label: "Plan", to: "/?panel=plan", Icon: Target },
  { key: "motivation", label: "Curated for you", shortLabel: "Curated", to: "/?panel=motivation", Icon: Sparkles },
];

/** Every routable screen by key — the six tabs plus the tabless keys. */
export const SCREEN_BY_KEY = Object.fromEntries(ROUTABLE_SCREENS.map((s) => [s.key, s]));

/**
 * Active screen key for a location search string. Unknown/absent → "home".
 * A key carrying `supersededBy` resolves to its successor instead.
 */
export function screenKeyFromSearch(search) {
  const key = new URLSearchParams(search).get("panel");
  const screen = SCREEN_BY_KEY[key];
  if (!screen) return "home";
  return screen.supersededBy || key;
}

/**
 * Search-params object for setSearchParams/Link that lands on a screen.
 * Home gets `{}` so the canonical URL stays clean `/`, never `/?panel=home`.
 */
export function searchForScreen(key) {
  return key === "home" ? {} : { panel: key };
}
