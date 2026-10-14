import { useCallback, useEffect, useState } from "react";
import { CalendarCheck, CalendarPlus, Check, Copy } from "lucide-react";
import CenteredDialog from "./CenteredDialog";
import { api } from "../lib/api";

/**
 * Calendar sync — subscribe the user's own calendar app to their plan feed.
 *
 * There is no OAuth here: the backend mints a secret `.ics` URL and the user's
 * calendar app (Google / Apple / Outlook) subscribes to it once, then re-fetches
 * it on its own schedule. So "keeps updating" is the calendar's job, not ours.
 *
 * Three pieces, one hook:
 *   useCalendarFeed     — the feed envelope + enable / dismiss / revoke
 *   CalendarSyncDialog  — the ask (first open) and the "where to add it" step
 *   CalendarSyncButton  — the always-there entry point on Timeline
 *   CalendarSyncPrompt  — mounts the dialog once, iff the account was never asked
 */

/** Google's refresh cadence for subscribed calendars — told to the user so a
 *  slow first sync does not read as broken. */
const GOOGLE_REFRESH_NOTE = "Google refreshes subscribed calendars every few hours.";
const COPY_RESET_MS = 1800;
/** Broadcast so the shell prompt and the Timeline button never disagree. */
const FEED_EVENT = "sutra:calendar-feed";

export function useCalendarFeed() {
  const [feed, setFeed] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    api.calendarFeed().then((f) => live && setFeed(f)).catch(() => {});
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
    enable: () => run(api.enableCalendarFeed),
    dismiss: () => run(api.dismissCalendarPrompt),
    revoke: () => run(api.revokeCalendarFeed),
  };
}

const PROVIDERS = [
  { key: "google", label: "Google Calendar", urlKey: "google_url", newTab: true },
  { key: "apple", label: "Apple Calendar / iPhone", urlKey: "webcal_url", newTab: false },
  { key: "outlook", label: "Outlook", urlKey: "outlook_url", newTab: true },
];

function ProviderLinks({ feed }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(feed.ics_url);
      setCopied(true);
      setTimeout(() => setCopied(false), COPY_RESET_MS);
    } catch {
      /* clipboard blocked — the URL is still visible to select by hand */
    }
  };
  return (
    <div className="space-y-2">
      {PROVIDERS.map((p) => (
        <a
          key={p.key}
          data-testid={`calendar-provider-${p.key}`}
          href={feed[p.urlKey]}
          target={p.newTab ? "_blank" : undefined}
          rel={p.newTab ? "noreferrer" : undefined}
          className="flex items-center justify-between w-full border border-[var(--border)] px-4 py-3 text-sm text-[var(--text-primary)] hover:border-[var(--accent)] transition-colors"
        >
          {p.label}
          <CalendarPlus className="w-4 h-4 text-[var(--text-muted)]" aria-hidden="true" />
        </a>
      ))}
      <button
        type="button"
        onClick={copy}
        className="flex items-center justify-between w-full border border-dashed border-[var(--border)] px-4 py-3 text-sm text-[var(--text-secondary)] hover:border-[var(--accent)] transition-colors"
      >
        {copied ? "Link copied" : "Copy link (any other calendar)"}
        {copied ? <Check className="w-4 h-4" aria-hidden="true" /> : <Copy className="w-4 h-4" aria-hidden="true" />}
      </button>
      <p className="font-mono text-[11px] text-[var(--text-muted)] leading-relaxed pt-1">
        Add it once — after that your calendar pulls every change to your plan by itself. {GOOGLE_REFRESH_NOTE}
      </p>
    </div>
  );
}

/**
 * The dialog. Not enabled → the ask ("Add your plan to your calendar?").
 * Enabled → which calendar app to add it to, plus "Stop syncing".
 */
export function CalendarSyncDialog({ open, onClose, state }) {
  const { feed, busy, error, enable, dismiss, revoke } = state;
  const enabled = !!feed?.enabled;

  const notNow = async () => {
    if (!feed?.prompted) await dismiss();
    onClose();
  };

  const footer = enabled ? (
    <div className="flex items-center justify-between w-full">
      <button
        type="button"
        onClick={revoke}
        disabled={busy}
        className="text-xs text-[var(--text-muted)] hover:text-[var(--danger,#c0392b)] disabled:opacity-50"
      >
        Stop syncing
      </button>
      <button type="button" onClick={onClose} className="px-4 py-2 text-sm bg-[var(--text-primary)] text-[var(--bg-primary)]">
        Done
      </button>
    </div>
  ) : (
    <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 w-full">
      <button type="button" onClick={notNow} disabled={busy} className="px-4 py-2.5 text-sm text-[var(--text-secondary)] disabled:opacity-50">
        Not now
      </button>
      <button
        type="button"
        onClick={enable}
        disabled={busy}
        className="px-4 py-2.5 text-sm font-medium bg-[var(--text-primary)] text-[var(--bg-primary)] disabled:opacity-50"
      >
        {busy ? "Setting up…" : "Add to my calendar"}
      </button>
    </div>
  );

  return (
    <CenteredDialog
      open={open}
      onClose={enabled ? onClose : notNow}
      testId="calendar-sync-dialog"
      title={enabled ? "Add Sutra to your calendar" : "See your plan in your calendar?"}
      icon={enabled ? CalendarCheck : CalendarPlus}
      maxWidth="max-w-md"
      footer={footer}
    >
      {enabled ? (
        <ProviderLinks feed={feed} />
      ) : (
        <p className="text-sm leading-relaxed text-[var(--text-secondary)]">
          Your daily steps and focus blocks show up in Google, Apple or Outlook Calendar — with a reminder before
          each block — and stay in step when your plan changes. You can turn it off any time.
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

/** Timeline entry point. Always rendered, so declining the prompt is never final. */
export function CalendarSyncButton({ state: external, compact = false }) {
  const own = useCalendarFeed();
  const state = external || own;
  const [open, setOpen] = useState(false);
  const enabled = !!state.feed?.enabled;
  const Icon = enabled ? CalendarCheck : CalendarPlus;
  return (
    <>
      <button
        type="button"
        data-testid="calendar-sync-button"
        onClick={() => setOpen(true)}
        aria-label={enabled ? "Synced to calendar" : "Sync to calendar"}
        title={enabled ? "Synced to calendar" : "Sync to calendar"}
        className={`inline-flex items-center justify-center gap-2 h-11 sm:h-9 ${compact ? "w-11" : "px-3"} text-xs rounded border transition-colors ${
          enabled
            ? "border-[var(--accent)] text-[var(--accent)]"
            : "border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--accent)]"
        }`}
      >
        <Icon className="w-4 h-4" aria-hidden="true" />
        {!compact && (enabled ? "Synced to calendar" : "Sync to calendar")}
      </button>
      <CalendarSyncDialog open={open} onClose={() => setOpen(false)} state={state} />
    </>
  );
}

/** Mount once at app shell. Opens by itself only if this account was never asked. */
export function CalendarSyncPrompt() {
  const state = useCalendarFeed();
  // Latched: once shown it stays up until closed, so after "Add" the same
  // dialog flips to the provider links instead of vanishing.
  const [phase, setPhase] = useState("idle"); // idle → asking → closed
  useEffect(() => {
    if (phase === "idle" && state.feed && !state.feed.prompted && !state.feed.enabled) setPhase("asking");
  }, [phase, state.feed]);
  return <CalendarSyncDialog open={phase === "asking"} onClose={() => setPhase("closed")} state={state} />;
}
