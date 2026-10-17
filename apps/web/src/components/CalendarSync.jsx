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
 *   CalendarSyncDialog  — one screen: a row per provider, linked or not
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
/** One sentence under the add link: in that provider's terms, why subscribing once is enough. */
const ADD_HELP = {
  google: "Add it once and Google keeps your plan in step by itself.",
  apple: "Add it once and your iPhone and Mac keep your plan in step by themselves.",
  outlook: "Add it once and Outlook keeps your plan in step whenever it refreshes.",
  other: "Add it once and your calendar app keeps your plan in step whenever it refreshes.",
  generic: "Add it once — after that the calendar pulls every change to your plan by itself.",
};
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

/**
 * The ways to add this feed. `provider` narrows the list to one calendar app: inside a linked row only that
 * row's own way makes sense, and a stack of every provider's full-width button reads as a picker the user
 * has already made. Left out (the picker after linking), every provider is listed.
 */
function AddLinks({ cal, provider }) {
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
  const offered = provider ? PROVIDERS.filter((p) => p.key === provider) : PROVIDERS;
  const withUrl = offered.filter((p) => p.urlKey);
  // Keep the provider the calendar was created for first, so the one-tap add sits at the top.
  const first = withUrl.find((p) => p.key === cal.provider);
  const ordered = first ? [first, ...withUrl.filter((p) => p !== first)] : withUrl;
  // "Another calendar" has no deep link, so copying is its whole answer rather than a fallback under one.
  const copyIsOnly = ordered.length === 0;
  const help = `${ADD_HELP[provider] || ADD_HELP.generic}${provider === "google" ? ` ${GOOGLE_REFRESH_NOTE}` : ""}`;
  return (
    <div className="space-y-1.5 pt-2">
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
      {copyIsOnly ? (
        <button
          type="button"
          onClick={copy}
          data-testid="calendar-copy-link"
          className="flex min-h-11 items-center justify-between w-full rounded-lg border border-dashed border-[var(--border)] px-4 text-sm text-[var(--text-secondary)] hover:border-[var(--accent)] transition-colors"
        >
          {copied ? "Link copied" : "Copy link"}
          {copied ? <Check className="w-4 h-4" aria-hidden="true" /> : <Copy className="w-4 h-4" aria-hidden="true" />}
        </button>
      ) : (
        <button
          type="button"
          onClick={copy}
          data-testid="calendar-copy-link"
          className="inline-flex min-h-9 items-center gap-1.5 py-1 text-[13px] text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors"
        >
          {copied ? <Check className="w-3.5 h-3.5" aria-hidden="true" /> : <Copy className="w-3.5 h-3.5" aria-hidden="true" />}
          {copied ? "Link copied" : "Copy link"}
        </button>
      )}
      <p className="text-[12px] text-[var(--text-muted)] leading-relaxed">{help}</p>
    </div>
  );
}

/** One link to one calendar: its state, how to add it, and a way to unlink it (alone). The provider's
 *  name is the row above; this is the line that says what that row is actually linked to. */
function CalendarRow({ cal, state, startExpanded }) {
  const [showAdd, setShowAdd] = useState(startExpanded);
  const [unlinking, setUnlinking] = useState(false);
  const [deleteEvents, setDeleteEvents] = useState(true);
  // A subscription created from this screen arrives after the click, so its row can mount before the
  // dialog knows it should be open. Follow the flag rather than only reading it at mount.
  useEffect(() => {
    if (startExpanded) setShowAdd(true);
  }, [startExpanded]);
  const provider = providerLabel(cal.provider);
  // A linked row shows only its own provider's way to add; an unknown key is "Another calendar", as above.
  const providerKey = PROVIDERS.some((p) => p.key === cal.provider) ? cal.provider : "other";
  // The server names a calendar after its provider unless the user renamed it; when they did, both are
  // worth showing — the provider says what it is, the name says which one.
  const renamed = cal.name && cal.name !== provider;

  return (
    <div data-testid={`calendar-row-${cal.id}`} className="rounded-lg bg-[var(--bg-primary)] p-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-sm font-medium text-[var(--text-primary)]">
            {renamed && <span className="truncate">{cal.name}</span>}
            <span
              data-testid={`calendar-linked-${cal.id}`}
              className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] px-2 py-0.5 text-[11px] font-medium text-[var(--accent)]"
            >
              <Check className="w-3 h-3" aria-hidden="true" /> Linked
            </span>
          </p>
          <p className="truncate text-[12px] text-[var(--text-muted)]">
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
          className="mt-1 inline-flex min-h-11 items-center gap-1 text-[13px] text-[var(--accent)]"
        >
          How to add it <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showAdd ? "rotate-180" : ""}`} aria-hidden="true" />
        </button>
      )}
      {showAdd && !unlinking && <AddLinks cal={cal} provider={providerKey} />}

      {unlinking && (
        <div className="mt-2 space-y-3 rounded-lg bg-[var(--bg-secondary)] p-3" data-testid={`calendar-unlink-panel-${cal.id}`}>
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
    </div>
  );
}

/** The row's Link action — the same add call the old picker made, now sitting on the provider it adds. */
function LinkButton({ provider, linking, disabled, onLink }) {
  return (
    <button
      type="button"
      onClick={() => onLink(provider)}
      disabled={disabled}
      data-testid={`calendar-link-${provider}`}
      className="min-h-11 shrink-0 inline-flex items-center gap-1.5 px-2 text-[13px] font-medium text-[var(--accent)] disabled:opacity-50"
    >
      {linking ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <CalendarPlus className="w-4 h-4" aria-hidden="true" />}
      Link
    </button>
  );
}

/**
 * One provider, on the one screen. Its active links are listed underneath it — each with its own Unlink —
 * and a Link button appears when nothing is linked to it. "Another calendar" is the one row that keeps
 * Link while linked, because a second copy of it is a second, unrelated calendar.
 */
function ProviderRow({ provider, calendars, state, linking, onLink, expandedId }) {
  const canLink = calendars.length === 0 || provider.key === "other";
  return (
    <li data-testid={`calendar-provider-row-${provider.key}`} className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-3">
      <div className={`flex items-center justify-between gap-2 ${canLink ? "min-h-11" : ""}`}>
        <p className="text-sm font-medium text-[var(--text-primary)]">{provider.label}</p>
        {canLink && <LinkButton provider={provider.key} linking={linking} disabled={state.busy} onLink={onLink} />}
      </div>
      {calendars.length > 0 && (
        <div className="mt-2 space-y-2">
          {calendars.map((cal) => (
            <CalendarRow key={cal.id} cal={cal} state={state} startExpanded={cal.id === expandedId} />
          ))}
        </div>
      )}
    </li>
  );
}

/**
 * The dialog — one screen. Every provider is a row: linked ones list their links with Unlink, unlinked
 * ones offer Link, and the add steps open inline under the row they belong to. Nothing navigates away.
 */
export function CalendarSyncDialog({ open, onClose, state }) {
  const { feed, error, link, dismiss } = state;
  // Only the live subscriptions are listed. An unlinked one keeps serving an empty feed for a month so
  // the user's calendar app drops Sutra's events — the server's job, and nothing to act on here.
  const linked = (feed?.calendars || []).filter(isLinked);
  const hasAny = linked.length > 0;
  // Providers are the rows, so an unknown key would otherwise vanish; it belongs to "Another calendar",
  // which is also what `providerLabel` calls it.
  const byProvider = PROVIDERS.reduce((acc, p) => ({ ...acc, [p.key]: [] }), {});
  linked.forEach((c) => (byProvider[c.provider] || byProvider.other).push(c));
  // The link whose add steps open by itself: the one this screen just created.
  const [expandedId, setExpandedId] = useState(null);
  const [linking, setLinking] = useState("");

  // Closing is the only decline now, so it still records that the account was asked — otherwise the
  // first-open prompt (CalendarSyncPrompt) would come back on every visit.
  const finish = async () => {
    if (!feed?.prompted) await dismiss();
    onClose();
  };

  const linkProvider = async (key) => {
    const known = new Set(linked.map((c) => c.id));
    setLinking(key);
    const next = await link(key);
    setLinking("");
    // The feed the call returned tells us which subscription is new, so only that one opens its steps.
    const created = (next?.calendars || []).find((c) => c.provider === key && !known.has(c.id) && isLinked(c));
    if (created) setExpandedId(created.id);
  };

  const footer = (
    <button type="button" onClick={finish} className="min-h-11 rounded-full bg-[var(--text-primary)] px-5 text-sm text-[var(--bg-primary)]">
      Done
    </button>
  );

  return (
    <CenteredDialog
      open={open}
      onClose={finish}
      testId="calendar-sync-dialog"
      title="Your calendars"
      icon={CalendarCheck}
      maxWidth="max-w-md"
      footer={footer}
    >
      {!hasAny && (
        <p className="mb-3 text-sm leading-relaxed text-[var(--text-secondary)]">
          Everything in your plan — sessions, fixed and repeating commitments, reminders, milestones and time away — shows up in Google,
          Apple or Outlook Calendar and stays in step when your plan changes.
        </p>
      )}
      <ul className="space-y-2.5" data-testid="calendar-list">
        {PROVIDERS.map((p) => (
          <ProviderRow
            key={p.key}
            provider={p}
            calendars={byProvider[p.key]}
            state={state}
            linking={linking === p.key}
            onLink={linkProvider}
            expandedId={expandedId}
          />
        ))}
      </ul>
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
