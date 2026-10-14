import { Link, useLocation } from "react-router-dom";
import { ChevronDown, LayoutDashboard } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { SCREENS, SCREEN_BY_KEY, screenKeyFromSearch } from "../constants/screens";
import SoonPill from "./SoonPill";

/**
 * GoalMenu — the app-wide navigation dropdown. On mobile it's the
 * large-title bar (the active screen name IS the trigger); on desktop
 * it's the complementary jump-to next to the tab strip.
 *
 * Lists every screen in `SCREENS` (Overview · Today · Goal · Timeline ·
 * Memories · Sources · Curated for you) with the active one marked and the
 * unfinished one carrying its Soon pill, so labels, icons, destinations and
 * the coming-soon marker never drift from constants/screens.js.
 *
 * The TRIGGER resolves through `SCREEN_BY_KEY`, which is the lookup that
 * knows every routable key — so a panel reachable by URL without being a tab
 * still titles itself correctly instead of falling back to "Overview".
 *
 * The avatar profile menu holds Settings / Theme / About / Sign out
 * (see Header.js).
 */
export default function GoalMenu({ align = "end", className = "", large = false }) {
  const location = useLocation();
  const activeKey = screenKeyFromSearch(location.search);
  const activeScreen = SCREEN_BY_KEY[activeKey];
  // The trigger label is the CURRENT active screen (e.g. "Plan"),
  // not hardcoded to Goals/Home.
  const triggerLabel = activeScreen?.label || "Overview";
  const TriggerIcon = activeScreen?.Icon || LayoutDashboard;

  // `large` renders the iOS large-title variant: the active screen name
  // becomes the page title (28px bold) with a chevron; the icon is
  // dropped so it reads as a heading, not a control.
  const triggerClass = large
    ? `inline-flex items-center gap-1.5 min-h-11 -mx-1 px-1 rounded-xl text-[19px] font-semibold tracking-tight whitespace-nowrap text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] ${className}`
    : `inline-flex items-center gap-1.5 min-h-11 px-2.5 -mx-1 rounded text-sm font-medium text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] ${className}`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid="goal-menu-trigger"
        aria-label="Navigate to another screen"
        className={triggerClass}
      >
        {!large && <TriggerIcon className="w-4 h-4 text-[var(--accent)]" aria-hidden="true" />}
        <span>{triggerLabel}</span>
        <ChevronDown className={large ? "w-5 h-5 text-[var(--text-muted)]" : "w-3.5 h-3.5 text-[var(--text-muted)]"} aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={align}
        sideOffset={6}
        data-testid="goal-menu-content"
        className="min-w-[220px]"
      >
        {/* List every screen (Home first). The active one is marked. */}
        {SCREENS.map((s) => {
          const Icon = s.Icon;
          const active = s.key === activeKey;
          return (
            <DropdownMenuItem
              key={s.key}
              asChild
              data-testid={`goal-menu-item-${s.key}`}
            >
              <Link
                to={s.to}
                aria-current={active ? "page" : undefined}
                className="flex items-center gap-2.5 cursor-pointer rounded-lg"
              >
                <Icon className={active ? "w-4 h-4 text-[var(--accent)]" : "w-4 h-4 text-[var(--text-muted)]"} aria-hidden="true" />
                <span className="flex-1 whitespace-nowrap">{s.label}</span>
                {/* The pill describes the screen, not where you are, so it
                    stays put on the screen itself; "here" is the separate
                    fact and the two sit side by side. */}
                {s.comingSoon && <SoonPill />}
                {active && (
                  <span className="text-[10px] uppercase tracking-widest text-[var(--accent)]">
                    here
                  </span>
                )}
              </Link>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}