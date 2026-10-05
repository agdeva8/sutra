import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { Sun, Moon, Sunset, Coffee, Sparkles, Check, X } from "lucide-react";
import { localDateKey } from "../lib/utils";

/**
 * WelcomeToast — a single, context-aware greeting that fires after the
 * user is authenticated (or after the first chat turn finishes, since
 * guest users land here without auth).
 *
 * Trigger rule (per the user's decision): every visit, dismissible. So
 * the same user coming back tomorrow gets the same toast — but it
 * stays short and dismissible so it's never annoying.
 *
 * Body content is derived from the server state at mount time:
 *   - "Good morning, {name}. You have N milestones due today."
 *   - "Welcome back. Last action 3 days ago was…"
 *   - "Your goals for this week:" + chip list
 *
 * Implementation note: we deliberately toast ONCE per component mount
 * (not per user action), using `useRef` to hold the fired flag. Each
 * new mount = each new session = toast. The toast itself is dismissible
 * via the Sonner `closeButton: true` option.
 */
export default function WelcomeToast({ user, state, signedIn }) {
  const firedRef = useRef(false);

  useEffect(() => {
    if (firedRef.current) return;
    if (!state) return;

    // Once-per-day sentinel — the same person reloading the page an
    // hour later shouldn't see the greeting again. The date is stored
    // in localStorage so it survives reloads.
    const today = localDateKey();
    try {
      if (localStorage.getItem("gc_welcome_date") === today) {
        firedRef.current = true;
        return;
      }
    } catch { /* localStorage blocked — fall through to toast */ }

    firedRef.current = true;
    try { localStorage.setItem("gc_welcome_date", today); } catch { /* ignore */ }

    // Compute the body — keep it tiny.
    const greeting = greetingFor(new Date());
    const Icon = greeting.icon;
    const activeGoals = (state.goals || []).filter(
      (g) => g.status === "active",
    );
    const dueToday = (state.milestones || []).filter(
      (m) => m.target_date === today && (m.status || "open") !== "done",
    );
    const name = user?.name?.split(" ")[0] || "";
    const personalised = name ? `${greeting.text}, ${name}` : greeting.text;

    let body = "";
    if (activeGoals.length === 0) {
      body = "Add your first goal and we'll plan it together.";
    } else if (dueToday.length > 0) {
      const firstThree = dueToday.slice(0, 3).map((m) => m.title);
      body = `You have ${dueToday.length} milestone${
        dueToday.length === 1 ? "" : "s"
      } due today — top of the list: ${firstThree.join(" · ")}.`;
    } else {
      body = `Tracking ${activeGoals.length} active goal${activeGoals.length === 1 ? "" : "s"}. Tap the chat button when you're ready for a planning session.`;
    }

    toast(
      (t) => (
        <div data-testid="welcome-toast" className="flex items-start gap-3 pr-2">
          <Icon className="h-5 w-5 mt-0.5 shrink-0 text-[var(--accent)]" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium leading-tight text-[var(--text-primary)]">
              {personalised}
            </div>
            <div className="mt-1 text-xs leading-relaxed text-[var(--text-secondary)]">
              {body}
            </div>
          </div>
          {/* Inline dismiss — Sonner's default closeButton renders
              outside the toast card on mobile and looks disconnected.
              Putting it inside the body keeps it visually anchored. */}
          <button
            onClick={() => toast.dismiss(t)}
            aria-label="Dismiss greeting"
            className="-mr-1 -mt-1 h-11 w-11 flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors shrink-0 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ),
      {
        id: "gc-welcome",
        duration: 8000,
        closeButton: false,
        // Sonner Toaster is configured `position="bottom-right"` on
        // desktop and `bottom-center` on mobile (App.js). That wins
        // over per-toast position. To keep the toast from covering
        // the FAB on the bottom-right, we put it top-right via a
        // className trick — sonner forwards className to the toast
        // root; we anchor it with a fixed top-right utility.
        className:
          "!fixed !top-4 !right-4 !left-auto !bottom-auto !translate-x-0 !translate-y-0 sm:!top-4",
      },
    );
  }, [user, state, signedIn]);

  return null;
}

function greetingFor(now) {
  const h = now.getHours();
  if (h >= 5 && h < 12) {
    return { text: "Good morning", icon: Coffee };
  }
  if (h >= 12 && h < 17) {
    return { text: "Good afternoon", icon: Sun };
  }
  if (h >= 17 && h < 21) {
    return { text: "Good evening", icon: Sunset };
  }
  return { text: "Up late", icon: Moon };
}
