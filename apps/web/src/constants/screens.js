import {
  LayoutDashboard,
  Sparkles,
  Target,
  Flag,
  CalendarDays,
  CalendarClock,
  Image as ImageIcon,
  FileText,
  PenLine,
  ListTodo,
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
 * Seven screens, one per tab, in this order:
 *   - **Overview** — the landing: greeting, today at a glance, and a
 *     read-only preview of the goals that links through to Goal.
 *   - **Today** — the day's timetable.
 *   - **Goal** — where goals are read and edited (the horizon-grouped board,
 *     each card carrying its own actions) and where the plan opens from.
 *   - **Timeline** — the calendar's Day → Year zoom surface.
 *   - **Memories** / **Sources** — the coach's material for the goals.
 *   - **Curated for you** — recommendations for the goals you're working on.
 *     Flagged `comingSoon`: the screen is still a placeholder, and the nav
 *     draws its Soon pill from that same flag rather than its own list.
 *
 * Plan still has no tab. It is not deleted — it stays routable through
 * ROUTABLE_SCREENS and Coach's panel switch, so an old link or a chat
 * "take me there" still lands on it.
 */
export const SCREENS = [
  // Scratch is the phone's front door (reflex capture) and a desktop tab too.
  // `mobileOnly` is still honoured by DESKTOP_SCREENS for any screen that needs it.
  { key: "scratch", label: "Scratch", to: "/?panel=scratch", Icon: PenLine },
  // Goal is the landing. It used to be Overview, which answered "where am I right now" while Goal
  // answered "what am I working on" — but the first answer is four lines of greeting and a glance, and
  // a whole tab for it meant the two screens opened with the same block and read as duplicates. The
  // greeting and the glance now sit at the top of Goal, and Overview has no tab.
  { key: "state", label: "Goal", to: "/", Icon: Flag },
  { key: "today", label: "Today", to: "/?panel=today", Icon: CalendarDays },
  // The user's own list: every to-do, from here, Today's "+ To-do" or Scratch.
  { key: "todos", label: "To-dos", to: "/?panel=todos", Icon: ListTodo },
  { key: "timeline", label: "Timeline", to: "/?panel=timeline", Icon: CalendarClock },
  { key: "memories", label: "Memories", to: "/?panel=memories", Icon: ImageIcon },
  { key: "sources", label: "Sources", to: "/?panel=sources", Icon: FileText },
  // `comingSoon` is the only source of the Soon marker — the nav reads it
  // instead of keeping its own list of unfinished screens.
  { key: "motivation", label: "Curated for you", shortLabel: "Curated", to: "/?panel=motivation", Icon: Sparkles, comingSoon: true },
];

/**
 * Screens pinned to the mobile bottom tab bar, in order. The rest of
 * `SCREENS` collapses behind the bar's trailing "More" button, so the bar
 * stays at five targets (four pinned + More) however many screens exist.
 * Timeline lives in More: Today's day/week/month views cover the daily look-ahead on a phone.
 */
export const MOBILE_TAB_KEYS = ["scratch", "state", "today", "todos"];

/** Screens drawn in the desktop tab strip: everything not flagged `mobileOnly`. */
export const DESKTOP_SCREENS = SCREENS.filter((s) => !s.mobileOnly);

/**
 * Which screen a fresh phone-width open lands on. With at least one goal the
 * user lands on Scratch; with none, on the Goal screen, where they add one
 * (Scratch can only file against existing goals). Desktop keeps Overview.
 */
export const MOBILE_LANDING_WITH_GOALS = "scratch";
export const MOBILE_LANDING_NO_GOALS = "state";
export const MOBILE_MAX_WIDTH_PX = 639; // Tailwind `sm` starts at 640

export function mobileLandingKey(goalCount) {
  return goalCount > 0 ? MOBILE_LANDING_WITH_GOALS : MOBILE_LANDING_NO_GOALS;
}

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
  // Overview has no tab any more; the key stays routable so a bookmark or a chat "take me there"
  // still lands somewhere real instead of bouncing to the landing.
  { key: "home", label: "Overview", to: "/?panel=home", Icon: LayoutDashboard },
];

/** Every routable screen by key — the tabs plus the tabless keys. */
export const SCREEN_BY_KEY = Object.fromEntries(ROUTABLE_SCREENS.map((s) => [s.key, s]));

/** Where an unknown or absent `?panel=` lands. Goal is the landing screen now. */
export const LANDING_SCREEN = "state";

/**
 * Active screen key for a location search string. Unknown/absent → the landing.
 * A key carrying `supersededBy` resolves to its successor instead.
 */
export function screenKeyFromSearch(search) {
  const key = new URLSearchParams(search).get("panel");
  const screen = SCREEN_BY_KEY[key];
  if (!screen) return LANDING_SCREEN;
  return screen.supersededBy || key;
}

/**
 * Search-params object for setSearchParams/Link that lands on a screen.
 * The landing screen gets `{}` so the canonical URL stays clean `/`, never `/?panel=state`.
 */
export function searchForScreen(key) {
  return key === LANDING_SCREEN ? {} : { panel: key };
}
