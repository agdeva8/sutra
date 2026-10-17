import { useCallback, useEffect, useState } from "react";
import { CalendarCheck, CalendarPlus, Check, ChevronDown, Copy, Loader2, Trash2 } from "lucide-react";
import CenteredDialog from "./CenteredDialog";
import { api } from "../lib/api";

/**
 * Calendar sync — subscribe the user's calendar apps to their plan.
 *
 * There is no OAuth here: for each calendar the backend mints its own secret `.ics` URL and the calendar
 * app (Google / Apple / Outlook) subscribes to it once, then re-fetches it on its own schedule. Every
 * linked calendar is separate: it can be added, renamed and unlinked on its own. Unlinking offers to clear
 * the events Sutra created in it (the feed goes empty, so the calendar app drops them on its next refresh).
 *
 *   useCalendarFeed     — the envelope + link / unlink / dismiss
 *   CalendarSyncDialog  — the ask (first open), the linked calendars, and unlinking
 *   CalendarSyncButton  — the always-there entry point on Timeline
 *   CalendarSyncPrompt  — mounts the dialog once, iff the account was never asked
 */

/** Google's refresh cadence for subscribed calendars — told to the user so a slow first sync does not read as broken. */
const GOOGLE_REFRESH_NOTE = "Google refreshes subscribed calendars every few hours.";
const COPY_RESET_MS = 1800;
/** Broadcast so the shell prompt and the Timeline button never disagree. */
const FEED_EVENT = "sutra:calendar-feed";

const PROVIDERS = [
  { key: "google", label: "Google Calendar", urlKey: "google_url", newTab: true },
  { key: "apple", label: "Apple Calendar / iPhone", urlKey: "webcal_url", newTab: false },
  { key: "outlook", label: "Outlook", urlKey: "outlook_url", newTab: true },
  { key: "other", label: "Another calendar", urlKey: null, newTab: false },
];
/** Where the user removes the subscription itself, which only the calendar app can do. */
const REMOVE_HELP = {
  google: "In Google Calendar, open Settings, pick this calendar under “Settings for other calendars” and choose Unsubscribe.",
  apple: "On your iPhone: Settings → Calendar → Accounts → Subscribed Calendars, then delete it. On a Mac, right-click the calendar and choose Unsubscribe.",
  outlook: "In Outlook, right-click the calendar under “Other calendars” and choose Remove.",
  other: "Remove the calendar inside your calendar app.",
};

export function useCalendarFeed() {
  const [feed, setFeed] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    api.calendarFeeds().then((f) => live && setFeed(f)).catch(() => {});
    const onChange = (e) => setFeed(e.detail);
    window.addEventListener(FEED_EVENT, onChange);
    return () => {
      live = false;
      window.removeEventListener(FEED_EVENT, onChange);
    };
  }, []);

  const run = useCallback(async (call) => {
    setBusy(true);
    setError("");
    try {
      const next = await call();
      window.dispatchEvent(new CustomEvent(FEED_EVENT, { detail: next }));
      return next;
    } catch (e) {
      setError(e.message || "Something went wrong");
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  return {
    feed,
    busy,
    error,
    link: (provider, name) => run(() => api.linkCalendar({ provider, name })),
    unlink: (id, deleteEvents) => run(() => api.unlinkCalendar(id, deleteEvents)),
    rename: (id, name) => run(() => api.renameCalendar(id, name)),
    dismiss: () => run(api.dismissCalendarPrompt),
  };
}

const when = (iso) => (iso ? new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "");

/** The provider's name, as the picker spells it. A calendar the server named after its provider reads
 *  as "Google Calendar"; one the user renamed keeps its own name and shows the provider beneath. */
const providerLabel = (key) => PROVIDERS.find((p) => p.key === key)?.label || PROVIDERS[PROVIDERS.length - 1].label;

/**
 * Only a live subscription is the user's business. Unlinking leaves the row on the server for a month
 * serving an empty feed, which is what makes the user's calendar app drop Sutra's events — nothing to
 * show here, and listing it would read as "still linked".
 */
const isLinked = (cal) => cal.status === "active";

function AddLinks({ cal }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(cal.ics_url);
      setCopied(true);
      setTimeout(() => setCopied(false), COPY_RESET_MS);
    } catch {
      /* clipboard blocked — the URL is still visible to select by hand */
    }
  };
  const first = PROVIDERS.find((p) => p.key === cal.provider && p.urlKey);
  const ordered = first ? [first, ...PROVIDERS.filter((p) => p !== first && p.urlKey)] : PROVIDERS.filter((p) => p.urlKey);
  return (
    <div className="space-y-2 pt-2">
      {ordered.map((p) => (
        <a
          key={p.key}
          data-testid={`calendar-provider-${p.key}`}
          href={cal[p.urlKey]}
          target={p.newTab ? "_blank" : undefined}
          rel={p.newTab ? "noreferrer" : undefined}
          className="flex min-h-11 items-center justify-between w-full rounded-lg border border-[var(--border)] px-4 text-sm text-[var(--text-primary)] hover:border-[var(--accent)] transition-colors"
        >
          Add to {p.label}
          <CalendarPlus className="w-4 h-4 text-[var(--text-muted)]" aria-hidden="true" />
        </a>
      ))}
      <button
        type="button"
        onClick={copy}
        className="flex min-h-11 items-center justify-between w-full rounded-lg border border-dashed border-[var(--border)] px-4 text-sm text-[var(--text-secondary)] hover:border-[var(--accent)] transition-colors"
      >
        {copied ? "Link copied" : "Copy link (any other calendar)"}
        {copied ? <Check className="w-4 h-4" aria-hidden="true" /> : <Copy className="w-4 h-4" aria-hidden="true" />}
      </button>
      <p className="text-[12px] text-[var(--text-muted)] leading-relaxed">
        Add it once — after that the calendar pulls every change to your plan by itself. {GOOGLE_REFRESH_NOTE}
      </p>
    </div>
  );
}

/** One linked calendar: its provider, its state, how to add it, and a way to unlink it (alone). */
function CalendarRow({ cal, state }) {
  const [showAdd, setShowAdd] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const [deleteEvents, setDeleteEvents] = useState(true);
  const provider = providerLabel(cal.provider);
  // The server names a calendar after its provider unless the user renamed it; when they did, both are
  // worth showing — the provider says what it is, the name says which one.
  const renamed = cal.name && cal.name !== provider;

  return (
    <li data-testid={`calendar-row-${cal.id}`} className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-sm font-medium text-[var(--text-primary)]">
            <span className="truncate">{provider}</span>
            <span
              data-testid={`calendar-linked-${cal.id}`}
              className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] px-2 py-0.5 text-[11px] font-medium text-[var(--accent)]"
            >
              <Check className="w-3 h-3" aria-hidden="true" /> Linked
            </span>
          </p>
          <p className="truncate text-[12px] text-[var(--text-muted)]">
            {renamed && <span className="text-[var(--text-secondary)]">{cal.name} · </span>}
            {cal.last_fetched_at ? `Last synced ${when(cal.last_fetched_at)}` : "Waiting for the calendar's first sync"}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setUnlinking((v) => !v)}
          data-testid={`calendar-unlink-${cal.id}`}
          className="min-h-11 shrink-0 inline-flex items-center gap-1.5 px-2 text-[13px] text-[var(--text-muted)] hover:text-[var(--danger,#c0392b)]"
        >
          <Trash2 className="w-4 h-4" aria-hidden="true" /> Unlink
        </button>
      </div>

      {!unlinking && (
        <button
          type="button"
          onClick={() => setShowAdd((v) => !v)}
          aria-expanded={showAdd}
          className="mt-1 inline-flex min-h-9 items-center gap-1 text-[13px] text-[var(--accent)]"
        >
          How to add it <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showAdd ? "rotate-180" : ""}`} aria-hidden="true" />
        </button>
      )}
      {showAdd && !unlinking && <AddLinks cal={cal} />}

      {unlinking && (
        <div className="mt-2 space-y-3 rounded-lg bg-[var(--bg-primary)] p-3" data-testid={`calendar-unlink-panel-${cal.id}`}>
          <p className="text-[13px] text-[var(--text-primary)]">Stop syncing “{provider}”? Your other calendars are not affected.</p>
          <label className="flex items-start gap-2.5 text-[13px] text-[var(--text-secondary)]">
            <input type="checkbox" checked={deleteEvents} onChange={(e) => setDeleteEvents(e.target.checked)} className="mt-0.5 h-4 w-4" data-testid="calendar-delete-events" />
            <span>
              Also delete the events Sutra added to this calendar
              <span className="block text-[12px] text-[var(--text-muted)]">
                {deleteEvents
                  ? "They disappear on its next refresh (a few hours for Google)."
                  : "They stay as they are now, but stop updating."}
              </span>
            </span>
          </label>
          <p className="text-[12px] text-[var(--text-muted)] leading-relaxed">{REMOVE_HELP[cal.provider] || REMOVE_HELP.other}</p>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setUnlinking(false)} className="min-h-11 px-3 text-sm text-[var(--text-secondary)]">
              Keep it
            </button>
            <button
              type="button"
              data-testid="calendar-unlink-confirm"
              disabled={state.busy}
              onClick={() => state.unlink(cal.id, deleteEvents)}
              className="min-h-11 rounded-full bg-[var(--danger,#c0392b)] px-4 text-sm font-medium text-white disabled:opacity-50"
            >
              {state.busy ? "Unlinking…" : "Unlink"}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

/**
 * The dialog. Nothing linked → the ask ("See your plan in your calendar?"). Otherwise the linked calendars,
 * each with its own add and unlink controls, and a way to link another.
 */
export function CalendarSyncDialog({ open, onClose, state }) {
  const { feed, busy, error, link, dismiss } = state;
  // Only the live subscriptions are listed. An unlinked one keeps serving an empty feed for a month so
  // the user's calendar app drops Sutra's events — the server's job, and nothing to act on here.
  const linked = (feed?.calendars || []).filter(isLinked);
  const hasAny = linked.length > 0;
  // Providers already linked: the picker is for adding one you do not have.
  const linkedProviders = new Set(linked.map((c) => c.provider));
  const [adding, setAdding] = useState(false);

  const notNow = async () => {
    if (!feed?.prompted) await dismiss();
    onClose();
  };

  const linkProvider = async (provider) => {
    await link(provider);
    setAdding(false);
  };

  const providerPicker = (
    <div className="grid grid-cols-1 gap-2" data-testid="calendar-provider-picker">
      {PROVIDERS.map((p) => {
        const already = linkedProviders.has(p.key);
        return (
          <button
            key={p.key}
            type="button"
            disabled={busy || already}
            onClick={() => linkProvider(p.key)}
            data-testid={`calendar-provider-option-${p.key}`}
            className="flex min-h-11 items-center justify-between rounded-lg border border-[var(--border)] px-4 text-sm text-[var(--text-primary)] hover:border-[var(--accent)] disabled:opacity-50"
          >
            {p.label}
            {already ? (
              <span className="inline-flex items-center gap-1 text-[12px] font-medium text-[var(--accent)]">
                <Check className="w-3.5 h-3.5" aria-hidden="true" /> Linked
              </span>
            ) : busy ? (
              <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
            ) : (
              <CalendarPlus className="w-4 h-4 text-[var(--text-muted)]" aria-hidden="true" />
            )}
          </button>
        );
      })}
    </div>
  );

  const footer = hasAny ? (
    <div className="flex items-center justify-between w-full">
      <button type="button" onClick={() => setAdding((v) => !v)} className="min-h-11 text-sm text-[var(--accent)]" data-testid="calendar-link-another">
        {adding ? "Cancel" : "Link another calendar"}
      </button>
      <button type="button" onClick={onClose} className="min-h-11 rounded-full bg-[var(--text-primary)] px-5 text-sm text-[var(--bg-primary)]">
        Done
      </button>
    </div>
  ) : (
    <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 w-full">
      <button type="button" onClick={notNow} disabled={busy} className="min-h-11 px-4 text-sm text-[var(--text-secondary)] disabled:opacity-50">
        Not now
      </button>
      <button type="button" onClick={() => setAdding(true)} disabled={busy} className="min-h-11 rounded-full bg-[var(--text-primary)] px-5 text-sm font-medium text-[var(--bg-primary)] disabled:opacity-50">
        Add to my calendar
      </button>
    </div>
  );

  return (
    <CenteredDialog
      open={open}
      onClose={hasAny ? onClose : notNow}
      testId="calendar-sync-dialog"
      title={hasAny ? "Your calendars" : "See your plan in your calendar?"}
      icon={hasAny ? CalendarCheck : CalendarPlus}
      maxWidth="max-w-md"
      footer={footer}
    >
      {hasAny && !adding && (
        <ul className="space-y-2.5" data-testid="calendar-list">
          {linked.map((c) => (
            <CalendarRow key={c.id} cal={c} state={state} />
          ))}
        </ul>
      )}
      {adding && (
        <div className="space-y-3">
          <p className="text-sm text-[var(--text-secondary)]">Which calendar are you adding?</p>
          {providerPicker}
        </div>
      )}
      {!hasAny && !adding && (
        <p className="text-sm leading-relaxed text-[var(--text-secondary)]">
          Everything in your plan — sessions, fixed and repeating commitments, reminders, milestones and time away — shows up in Google,
          Apple or Outlook Calendar and stays in step when your plan changes. Link as many calendars as you like, and unlink any of them
          whenever you want.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-xs text-[var(--danger,#c0392b)]">
          {error}
        </p>
      )}
    </CenteredDialog>
  );
}

/** What the button says. The compact form is the phone-width strip: the icon and the accent colour
 *  carry the linked state, so one short word fits the narrow bar without saying less. */
const syncLabel = (count, compact) => {
  if (compact) return count > 0 ? "Synced" : "Sync";
  if (count === 0) return "Sync calendar";
  return count > 1 ? `Synced to ${count} calendars` : "Synced to calendar";
};

/** Timeline entry point. Always rendered with its icon *and* its words — an icon alone does not say what
 *  the button does on a phone. Declining the prompt is never final. */
export function CalendarSyncButton({ state: external, compact = false }) {
  const own = useCalendarFeed();
  const state = external || own;
  const [open, setOpen] = useState(false);
  const count = (state.feed?.calendars || []).filter(isLinked).length;
  const enabled = count > 0;
  const Icon = enabled ? CalendarCheck : CalendarPlus;
  const label = syncLabel(count, compact);
  // The full wording, whatever the bar had room for: screen readers and hover both get the whole thing.
  const described = syncLabel(count, false);
  return (
    <>
      <button
        type="button"
        data-testid="calendar-sync-button"
        onClick={() => setOpen(true)}
        aria-label={described}
        title={described}
        className={`inline-flex h-11 shrink-0 items-center justify-center gap-2 px-3 text-xs rounded border transition-colors ${
          enabled
            ? "border-[var(--accent)] text-[var(--accent)]"
            : "border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--accent)]"
        }`}
      >
        <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
        <span className="whitespace-nowrap">{label}</span>
      </button>
      <CalendarSyncDialog open={open} onClose={() => setOpen(false)} state={state} />
    </>
  );
}

/** Mount once at app shell. Opens by itself only if this account was never asked. */
export function CalendarSyncPrompt() {
  const state = useCalendarFeed();
  const [phase, setPhase] = useState("idle"); // idle → asking → closed
  useEffect(() => {
    if (phase === "idle" && state.feed && !state.feed.prompted && !state.feed.enabled) setPhase("asking");
  }, [phase, state.feed]);
  return <CalendarSyncDialog open={phase === "asking"} onClose={() => setPhase("closed")} state={state} />;
}
