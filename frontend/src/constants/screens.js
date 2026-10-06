import {
  LayoutDashboard,
  Sparkles,
  Target,
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
 * drift apart.
 *
 * Routing note: `/` is the **Home** screen — the canonical landing — and
 * the other screens ride on `?panel=<key>` instead of their own pathname.
 * Coach.js is keyed by `location.pathname` (see App.js' ViewTransition
 * comment), so keeping the pathname constant across panel switches
 * guarantees the page never remounts: chat, dashboard data and scroll
 * survive every switch, and browser/system back still steps
 * screen-by-screen because each switch is a history push.
 *
 * Home (per founder feedback) is the personal landing: greeting +
 * recommendation + today at a glance + a goals preview. Goals holds the
 * actual goal list.
 */
export const SCREENS = [
  { key: "home", label: "Overview", to: "/", Icon: LayoutDashboard },
  { key: "plan", label: "Plan", to: "/?panel=plan", Icon: Target },
  { key: "state", label: "Goals", deprecated: true, to: "/?panel=state", Icon: Target },
  { key: "today", label: "Today", deprecated: true, to: "/?panel=today", Icon: CalendarDays },
  { key: "timeline", label: "Timeline", deprecated: true, to: "/?panel=timeline", Icon: CalendarClock },
  { key: "memories", label: "Memories", to: "/?panel=memories", Icon: ImageIcon },
  { key: "sources", label: "Sources", to: "/?panel=sources", Icon: FileText },
  { key: "motivation", label: "Curated for you", shortLabel: "Curated", to: "/?panel=motivation", Icon: Sparkles },
];

export const SCREEN_BY_KEY = Object.fromEntries(SCREENS.map((s) => [s.key, s]));

/** Active screen key for a location search string. Unknown/absent → "home". */
export function screenKeyFromSearch(search) {
  const key = new URLSearchParams(search).get("panel");
  return SCREEN_BY_KEY[key] ? key : "home";
}

/**
 * Search-params object for setSearchParams/Link that lands on a screen.
 * Home gets `{}` so the canonical URL stays clean `/`, never `/?panel=home`.
 */
export function searchForScreen(key) {
  return key === "home" ? {} : { panel: key };
}
