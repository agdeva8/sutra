import { clsx } from "clsx";
import { twMerge } from "tailwind-merge"

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

/**
 * The user's *local* calendar date as `YYYY-MM-DD`.
 *
 * Do NOT use `new Date().toISOString().slice(0, 10)` for this. `toISOString`
 * converts to UTC, so for any timezone ahead of UTC it returns *yesterday*
 * once the local clock passes midnight — in IST (+05:30) the whole of 00:00
 *–05:29 local resolves to the previous UTC day. That made "today's tasks"
 * hide the items actually due today and show yesterday's as overdue.
 * `setHours(0,0,0,0)` does not help either: it pins local midnight,
 * which `toISOString` then shifts backwards again.
 *
 * Date-only values from the API are stored as plain `YYYY-MM-DD` strings
 * with no zone, so they must be compared against a local date key, never a
 * UTC one.
 */
export function localDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Whether a dialog input should take focus on mount.
 *
 * True on desktop, false below Tailwind's `sm` (640px). On a phone the
 * sheet already animates up, so autofocus adds a second, conflicting
 * motion and the keyboard immediately covers the sheet's own content —
 * the user can no longer see what they're being asked. Keyboard flows
 * on desktop stay fast.
 *
 * Evaluated at mount time (dialogs mount on open), so it sees the
 * viewport that is actually on screen. `autoFocus={canAutofocus()}`
 * rather than a bare `autoFocus`.
 *
 * Ref: Vercel Web Interface Guidelines — "autoFocus — desktop only,
 * single primary input; avoid on mobile."
 */
export function canAutofocus() {
  return typeof window !== "undefined" && window.innerWidth >= 640;
}
