import { Link } from "react-router-dom";
import { Menu } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { useEffect, useState } from "react";
import { SCREENS, MOBILE_TAB_KEYS } from "../constants/screens";
import { hasOpenedScratch, markScratchOpened, onScratchOpenedChange } from "../lib/scratchIntro";
import SoonPill from "./SoonPill";

const ITEM_BASE =
  "flex-1 min-w-0 min-h-14 flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--accent)]";

const tone = (active) =>
  active ? "text-[var(--accent)]" : "text-[var(--text-muted)] hover:text-[var(--text-primary)]";

/**
 * MobileTabBar — the phone-width bottom navigation. Four pinned screens
 * (`MOBILE_TAB_KEYS`) plus a trailing hamburger that opens every other screen
 * from `SCREENS`, so the bar never grows past five targets and never keeps its
 * own screen list. Hidden from `sm` up, where Coach's tab strip takes over.
 */
export default function MobileTabBar({ activeKey }) {
  const pinned = SCREENS.filter((s) => MOBILE_TAB_KEYS.includes(s.key));
  const overflow = SCREENS.filter((s) => !MOBILE_TAB_KEYS.includes(s.key));
  const overflowActive = overflow.some((s) => s.key === activeKey);
  // A "new" dot on Scratch until it has been opened once.
  const [scratchOpened, setScratchOpened] = useState(hasOpenedScratch);
  useEffect(() => onScratchOpenedChange(() => setScratchOpened(hasOpenedScratch())), []);

  return (
    <nav
      aria-label="Screens"
      data-testid="mobile-tab-bar"
      className="sm:hidden shrink-0 flex items-stretch border-t border-[var(--border)] bg-[var(--bg-primary)] pb-[env(safe-area-inset-bottom)] z-30"
    >
      {pinned.map((s) => {
        const Icon = s.Icon;
        const active = s.key === activeKey;
        return (
          <Link
            key={s.key}
            to={s.to}
            aria-current={active ? "page" : undefined}
            data-testid={`mobile-tab-${s.key}`}
            onClick={s.key === "scratch" ? markScratchOpened : undefined}
            className={`${ITEM_BASE} ${tone(active)}`}
          >
            <span className="relative">
              <Icon className="w-5 h-5" aria-hidden="true" />
              {s.key === "scratch" && !scratchOpened && (
                <span data-testid="scratch-new-dot" className="absolute -right-1 -top-0.5 h-2 w-2 rounded-full bg-[var(--warning)]" />
              )}
            </span>
            <span className="truncate max-w-full px-0.5">{s.shortLabel || s.label}</span>
          </Link>
        );
      })}

      <DropdownMenu>
        <DropdownMenuTrigger
          data-testid="mobile-tab-more"
          aria-label="More screens"
          className={`${ITEM_BASE} ${tone(overflowActive)}`}
        >
          <Menu className="w-5 h-5" aria-hidden="true" />
          <span>More</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="top" sideOffset={8} className="min-w-[220px]">
          {overflow.map((s) => {
            const Icon = s.Icon;
            const active = s.key === activeKey;
            return (
              <DropdownMenuItem key={s.key} asChild data-testid={`mobile-more-item-${s.key}`}>
                <Link
                  to={s.to}
                  aria-current={active ? "page" : undefined}
                  className="flex items-center gap-2.5 min-h-11 cursor-pointer rounded-lg"
                >
                  <Icon
                    className={active ? "w-4 h-4 text-[var(--accent)]" : "w-4 h-4 text-[var(--text-muted)]"}
                    aria-hidden="true"
                  />
                  <span className="flex-1 whitespace-nowrap">{s.label}</span>
                  {s.comingSoon && <SoonPill />}
                </Link>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </nav>
  );
}
