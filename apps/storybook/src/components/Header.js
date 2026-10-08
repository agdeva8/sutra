import { useState, useRef, useEffect } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { LogOut, Info, LogIn, Settings, Sun, Moon, UserCircle2 } from "lucide-react";
import Logo from "./Logo";
import PersonaMenu from "./PersonaMenu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

// Header — Iteration 9 mobile shell. The hamburger sheet that used to
// host the secondary cluster (Settings / Theme / About / Sign in) plus
// the screen nav is gone. The nav lives in a Goals dropdown
// (`<GoalMenu>`, see GoalMenu.js) — Goals is the canonical landing, the
// other screens sit inside the dropdown — and the secondary cluster
// lives in the avatar / "Guest" profile menu below.
//
// Desktop (≥ sm): unchanged surface — full tab strip + secondary cluster
// (About / Theme / Settings) + avatar. The Goals dropdown is a
// complementary jump-to on the right of the avatar.
//
// Mobile (< sm): no tab strip; the Goals dropdown lives next to the
// active screen title bar; the avatar / Guest chip opens a profile menu
// (Settings / Theme / About / Sign out | Sign in).
export default function Header({ user, authLoading, onOpenChat, onOpenAbout, onSignIn, onLogout, devLoginAvailable = false, currentUserId }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [isLight, setIsLight] = useState(() => {
    if (typeof document === "undefined") return false;
    return document.documentElement.classList.contains("light");
  });
  const isGuest = !user || user.is_guest;
  const rootRef = useRef(null);

  useEffect(() => {
    const syncThemeColor = () => {
      const light = document.documentElement.classList.contains("light");
      const color = light ? "#FFFFFF" : "#000000";
      let meta = document.querySelector('meta[name="theme-color"]');
      if (!meta) {
        meta = document.createElement("meta");
        meta.setAttribute("name", "theme-color");
        document.head.appendChild(meta);
      }
      meta.setAttribute("content", color);
    };
    syncThemeColor();
    const mo = new MutationObserver(() => {
      setIsLight(document.documentElement.classList.contains("light"));
      syncThemeColor();
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, []);

  const toggleTheme = () => {
    const next = !document.documentElement.classList.contains("light");
    document.documentElement.classList.toggle("light", next);
    try { localStorage.setItem("sutra_theme", next ? "light" : "dark"); } catch { /* ignore */ }
    setIsLight(next);
  };

  useEffect(() => {
    const onDown = (e) => {
      // Radix DropdownMenu closes on outside click by default, but the
      // avatar menu's controlled `open` state is bound to menuOpen — the
      // onOpenChange handler keeps it in sync. We only need this
      // fallback for older browsers; on modern browsers Radix handles it.
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  // Shared row style for the avatar popover's items.
  const itemRow =
    "min-h-11 flex items-center gap-2.5 px-2.5 rounded text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]";

  return (
    <header
      data-testid="app-header"
      className="min-h-[calc(4rem+env(safe-area-inset-top))] pt-[env(safe-area-inset-top)] shrink-0 border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--bg-primary)_72%,transparent)] backdrop-blur-xl backdrop-saturate-150 px-4 sm:px-6 flex items-center gap-2 sm:gap-4 sticky top-0 z-50"
    >
      <Link
        to="/"
        data-testid="header-home-link"
        title="Sutra — go to home"
        className="flex items-center gap-2.5 min-w-0 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
      >
        <Logo className="w-8 h-8 text-[var(--accent)] shrink-0" />
        <div className="min-w-0 flex flex-col justify-center">
          <h1 className="font-bold tracking-tight text-base sm:text-lg leading-none">Sutra</h1>
          <span className="mt-0.5 text-[10px] sm:text-[11px] text-[var(--text-muted)] truncate leading-none">
            Let&apos;s sort your life — together.
          </span>
        </div>
      </Link>

      <div ref={rootRef} className="ml-auto flex items-center gap-2">
        {/* Desktop secondary cluster — unchanged */}
        <nav aria-label="Primary" className="hidden sm:flex items-center gap-2">
          <button
            data-testid="open-about-button"
            onClick={onOpenAbout}
            title="About Sutra, privacy & the founder"
            aria-label="About Sutra, privacy and the founder"
            className="h-11 w-11 flex items-center justify-center border border-[var(--border)] hover:border-[var(--border-accent)] text-[var(--text-secondary)] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] rounded"
          >
            <Info className="w-4 h-4" aria-hidden="true" />
          </button>
          <button
            data-testid="header-theme-toggle"
            onClick={toggleTheme}
            title={isLight ? "Switch to dark theme" : "Switch to light theme"}
            aria-label={isLight ? "Switch to dark theme" : "Switch to light theme"}
            aria-pressed={isLight}
            className="h-11 w-11 flex items-center justify-center border border-[var(--border)] hover:border-[var(--border-accent)] text-[var(--text-secondary)] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] rounded"
          >
            {isLight ? <Moon className="w-4 h-4" aria-hidden="true" /> : <Sun className="w-4 h-4" aria-hidden="true" />}
          </button>
          <button
            data-testid="header-settings-button"
            onClick={() => navigate("/settings")}
            title="Settings"
            aria-label="Settings"
            className="h-11 w-11 flex items-center justify-center border border-[var(--border)] hover:border-[var(--border-accent)] text-[var(--text-secondary)] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] rounded"
          >
            <Settings className="w-4 h-4" aria-hidden="true" />
          </button>
        </nav>

        {/* Goals menu — mobile / space-constrained only. On desktop
            the horizontal tab strip (Coach.js) is the nav; showing both
            was duplicating surface (founder feedback). The trigger is
            always labelled "Goals" — that's the canonical landing.

            Iteration 9+ (founder feedback): GoalMenu was duplicated on
            mobile — once here in the top header, once in the body
            header bar (Coach.js). Removed from the top header entirely;
            the body header bar holds the only GoalMenu trigger on
            mobile. Desktop stays unchanged (horizontal tab strip only). */}
        {/* GoalMenu removed from top header on mobile — see Coach.js */}

        {authLoading ? (
          <div className="h-11 w-11" aria-hidden="true" />
        ) : isGuest ? (
          <>
            {/* Mobile-only "Guest" chip — the avatar menu trigger for
                guests who don't have a profile picture. On desktop we
                keep the explicit "Sign in" button. */}
            <div className="sm:hidden">
              <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
                <DropdownMenuTrigger
                  data-testid="user-menu-trigger-guest"
                  aria-label="Open account menu"
                  title="Account"
                  className="h-11 px-3 inline-flex items-center gap-1.5 border border-[var(--border)] hover:border-[var(--border-accent)] text-[var(--text-secondary)] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] rounded text-xs font-medium"
                >
                  <UserCircle2 className="w-4 h-4" aria-hidden="true" />
                  <span>Guest</span>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" sideOffset={6} className="min-w-[200px]">
                  <DropdownMenuLabel className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] font-medium">
                    Browsing as guest
                  </DropdownMenuLabel>
                  <DropdownMenuItem
                    data-testid="guest-menu-settings"
                    onSelect={() => { navigate("/settings"); setMenuOpen(false); }}
                    className={itemRow}
                  >
                    <Settings className="w-4 h-4" aria-hidden="true" />
                    Settings
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    data-testid="guest-menu-theme"
                    onSelect={(e) => { e.preventDefault(); toggleTheme(); }}
                    className={itemRow}
                  >
                    {isLight ? <Moon className="w-4 h-4" aria-hidden="true" /> : <Sun className="w-4 h-4" aria-hidden="true" />}
                    {isLight ? "Dark theme" : "Light theme"}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    data-testid="guest-menu-about"
                    onSelect={() => { onOpenAbout?.(); setMenuOpen(false); }}
                    className={itemRow}
                  >
                    <Info className="w-4 h-4" aria-hidden="true" />
                    About Sutra
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    data-testid="guest-menu-signin"
                    onSelect={() => { onSignIn?.(); setMenuOpen(false); }}
                    className={`${itemRow} text-[var(--accent)]`}
                  >
                    <LogIn className="w-4 h-4" aria-hidden="true" />
                    Sign in
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            {devLoginAvailable && <PersonaMenu currentName={user?.name} currentUserId={currentUserId} />}
            <button
              data-testid="header-signin-button"
              onClick={onSignIn}
              title="Sign in with Google to save your work"
              aria-label="Sign in with Google to save your work"
              className="hidden sm:inline-flex h-11 items-center gap-2 px-3.5 bg-[var(--accent)] text-[var(--bg-primary)] font-medium text-xs hover:opacity-90 transition-opacity"
            >
              <LogIn className="w-3.5 h-3.5" /> Sign in
            </button>
          </>
        ) : (
          <>
            {devLoginAvailable && <PersonaMenu currentName={user?.name} currentUserId={currentUserId} />}
            <div className="relative">
              <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
                <DropdownMenuTrigger
                  data-testid="user-menu-trigger"
                  aria-label="Open account menu"
                  title="Account"
                  className="h-11 w-11 rounded-full overflow-hidden border border-[var(--border)] hover:border-[var(--border-accent)] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
                >
                  {user?.picture ? (
                    <img src={user.picture} alt={user.name} className="w-full h-full object-cover" />
                  ) : (
                    <span className="flex items-center justify-center w-full h-full text-xs">{user?.name?.[0] || "?"}</span>
                  )}
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" sideOffset={6} className="min-w-[220px]">
                  <DropdownMenuLabel className="px-2.5 py-2 text-[var(--text-primary)]">
                    <div className="text-xs font-medium truncate">{user?.name}</div>
                    <div className="text-[10px] text-[var(--text-muted)] truncate mt-0.5">{user?.email}</div>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    data-testid="user-menu-settings"
                    onSelect={() => { navigate("/settings"); setMenuOpen(false); }}
                    className={itemRow}
                  >
                    <Settings className="w-4 h-4" aria-hidden="true" />
                    Settings
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    data-testid="user-menu-theme"
                    onSelect={(e) => { e.preventDefault(); toggleTheme(); }}
                    className={itemRow}
                  >
                    {isLight ? <Moon className="w-4 h-4" aria-hidden="true" /> : <Sun className="w-4 h-4" aria-hidden="true" />}
                    {isLight ? "Dark theme" : "Light theme"}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    data-testid="user-menu-about"
                    onSelect={() => { onOpenAbout?.(); setMenuOpen(false); }}
                    className={itemRow}
                  >
                    <Info className="w-4 h-4" aria-hidden="true" />
                    About Sutra
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    data-testid="user-menu-logout"
                    onSelect={() => { onLogout?.(); setMenuOpen(false); }}
                    className={`${itemRow} text-[var(--danger)]`}
                  >
                    <LogOut className="w-4 h-4" aria-hidden="true" />
                    Sign out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </>
        )}
      </div>
    </header>
  );
}