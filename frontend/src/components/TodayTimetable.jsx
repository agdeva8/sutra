import { useState, useEffect, useRef, useCallback } from "react";
import { Calendar, CheckCircle2, Circle, Loader2, MessageSquareWarning, MessageSquarePlus, RefreshCw, MoreHorizontal, ChevronDown, ChevronUp } from "lucide-react";
import { api } from "../lib/api";
import { localDateKey } from "../lib/utils";

/**
 * TodayTimetable — today's timed blocks, commitments, and blockers.
 *
 * Per-item controls:
 *   - Clickable circle checkbox → mark done (PATCH /api/commitments/:id)
 *   - Two CTA buttons that open a SCOPED chat (blank composer, the modal
 *     is titled after the action + the item):
 *       · "I can't do this"   → renegotiate it (keep / shrink / drop)
 *       · "Break it down with coach" → smallest first step
 *
 * Per-item "what you did" note + per-item free-text chat input were
 * removed in Iteration 7 (Ask 1) — they cluttered every row and the
 * user only needs ONE place to talk about the day as a whole. The
 * section-level "Tell the coach anything about today" input now lives
 * inside the new Today tab (`frontend/src/components/Today.jsx`),
 * which renders this component and adds the section-level input
 * below.
 *
 * Designed to be rendered standalone on the Today tab. Also rendered
 * inside the TrackerCard with `compact=true` (list only, no header)
 * — kept for the Goals-tab quick glance until that path is folded in.
 */
export default function TodayTimetable({ state, onChange, onOpenChat, compact = false, fullTimetable = false }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(null); // id of item being saved

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      api.blockers(),
      api.commitments(),
      api.timetable(),
    ])
      .then(([blockersRes, commitmentsRes, timetableRes]) => {
        const rawBlockers = Array.isArray(blockersRes)
          ? blockersRes
          : (blockersRes?.blockers || []);
        const rawCommitments = Array.isArray(commitmentsRes)
          ? commitmentsRes
          : (commitmentsRes?.commitments || []);

        const todayKey = localDateKey();
        const todayBlockers = rawBlockers.filter(
          (b) => b.start_date === todayKey || (b.start_date <= todayKey && b.end_date >= todayKey),
        );
        // Match TrackerCard's `todayCommits` predicate exactly, so the
        // header counters ("N overdue", "M due today") always agree with
        // the rows below them:
        //   • anything due today, done or not
        //   • anything overdue while still open
        // A strict `due === today` match made an overdue commitment
        // vanish the moment you un-ticked it, and left the
        // "overdue first" sort below unreachable.
        const todayCommits = rawCommitments.filter(
          (c) => c.due === todayKey || (c.due && c.due < todayKey && c.status === "open"),
        );
        const todayBlocks = (timetableRes?.blocks || []).filter(
          (block) => block.block_date === todayKey,
        );
        const merged = [
          ...todayBlocks.map((block) => ({ ...block, text: block.label, _kind: "block" })),
          ...todayBlockers.map((b) => ({ ...b, _kind: "blocker" })),
          ...todayCommits.map((c) => ({ ...c, _kind: "commitment" })),
        ];
        // Timed blocks first in clock order; then blockers and commitments.
        merged.sort((a, b) => {
          const rank = { block: 0, blocker: 1, commitment: 2 };
          if (rank[a._kind] !== rank[b._kind]) return rank[a._kind] - rank[b._kind];
          if (a._kind === "block") return String(a.start_time).localeCompare(String(b.start_time));
          const aOver = a._kind === "commitment" && a.due < todayKey;
          const bOver = b._kind === "commitment" && b.due < todayKey;
          return aOver === bOver ? 0 : aOver ? -1 : 1;
        });
        setItems(merged);
      })
      .catch((err) => {
        console.error("Failed to load timetable items:", err);
        setError(err);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { refresh(); }, [refresh, state]);

  const toggleDone = async (c) => {
    if (c._kind !== "commitment") return;
    setSaving(c.id);
    // Optimistic flip
    setItems((prev) =>
      prev.map((b) => (b.id === c.id && b._kind === "commitment"
        ? { ...b, status: c.status === "done" ? "open" : "done" }
        : b))
    );
    try {
      await api.updateCommitment(c.id, {
        status: c.status === "done" ? "open" : "done",
      });
      onChange?.();
    } catch {
      refresh();
    } finally {
      setSaving(null);
    }
  };

  // Both openers below pass an EMPTY prefill on purpose. The button has
  // already named the action and the entity, so the modal titles itself
  // ("About: Renegotiate \"Investor email batch 2\"") and the composer
  // opens blank for the user's own words. The long canned paragraph that
  // used to be dropped in the box was the "prompt autofilled" complaint —
  // and because ChatModal only overwrote the input when a prefill was
  // non-empty, the previous chat's text leaked into the next one.
  const cantDoThis = (item) => {
    const title = item.text || item.title || "this commitment";
    onOpenChat?.(
      "",
      {
        scope: item._kind === "blocker" ? "blocker" : "commitment",
        refId: item.id,
        kind: "plan_day",
        title: `Renegotiate "${title}"`,
        helperText:
          "What part feels off? Be specific — the coach will suggest a keep / shrink / drop.",
      },
    );
  };
  const addToPlan = (item) => {
    const title = item.text || item.title || "this commitment";
    onOpenChat?.(
      "",
      {
        scope: item._kind === "blocker" ? "blocker" : "commitment",
        refId: item.id,
        kind: "plan_day",
        title: `Break down "${title}"`,
        helperText: "Describe the smallest concrete next step and the rough when.",
      },
    );
  };

  if (loading && items.length === 0) {
    // Iteration 5 (Bug 1) — always show a shimmer, even in compact mode.
    // TrackerCard renders TodayTimetable with `compact=true` and the old
    // path returned null, leaving the dashboard stuck on a blank spot
    // while the fetch ran.
    return (
      <div
        className={
          compact
            ? "flex items-center gap-1.5 py-1"
            : "border border-[var(--border)] rounded-lg p-4 space-y-2"
        }
        aria-busy="true"
        aria-live="polite"
      >
        <div className="h-3 w-32 gc-skeleton" />
        <div className="h-3 w-56 gc-skeleton" />
      </div>
    );
  }

  if (!loading && error) {
    return compact ? null : (
      <div className="border border-[var(--border)] rounded-lg p-4 text-center space-y-2 bg-[color-mix(in_srgb,var(--bg-secondary)_40%,transparent)]" data-testid="timetable-error">
        <p className="text-xs text-[var(--text-secondary)]">Couldn't load today's schedule</p>
        <button
          type="button"
          onClick={refresh}
          className="min-h-11 inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded bg-[var(--accent)] text-[var(--bg-primary)] font-medium hover:opacity-90 transition-opacity"
        >
          <RefreshCw className="w-3 h-3" />
          Try again
        </button>
      </div>
    );
  }

  if (!loading && items.length === 0) return null;

  const todayKey = localDateKey();
  const scheduledBlocks = items
    .filter((item) => item._kind === "block")
    .sort((a, b) => String(a.start_time).localeCompare(String(b.start_time)));

  return (
    <section
      data-testid="today-timetable"
      className="border border-[var(--border)] bg-[color-mix(in_srgb,var(--bg-secondary)_40%,transparent)] rounded-lg"
    >
      {!compact && (
        <header className="flex items-center gap-2 px-4 py-2.5 border-b border-[var(--border)]">
          <Calendar className="w-3.5 h-3.5 text-[var(--accent)]" aria-hidden="true" />
          <h2 className="font-medium text-xs text-[var(--text-secondary)]">
            {fullTimetable ? "Today's full timetable" : "Today's tasks"}
          </h2>
          <span className="ml-auto tabular-nums text-xs text-[var(--text-muted)]">
            {items.length} item{items.length === 1 ? "" : "s"}
          </span>
        </header>
      )}
      <ul className="divide-y divide-[var(--border)]" role="list">
        {items.map((item) => {
          const isCommitment = item._kind === "commitment";
          const isTimedBlock = item._kind === "block";
          const done = isCommitment && item.status === "done";
          const overdue = isCommitment && item.due && item.due < todayKey;
          return (
            <li
              key={`${item._kind}-${item.id}`}
              data-testid={`timetable-item-${item._kind}-${item.id}`}
              className="px-4 py-3 flex flex-col gap-2"
            >
              {/* Top row: checkbox + title + meta */}
              <div className="flex items-start gap-3">
                <button
                  type="button"
                  onClick={() => toggleDone(item)}
                  disabled={!isCommitment || saving === item.id}
                  aria-label={done ? `Mark "${item.text || item.title}" as not done` : `Mark "${item.text || item.title}" as done`}
                  aria-pressed={done}
                  data-testid={`timetable-checkbox-${item.id}`}
                  className={`mt-0.5 h-11 w-11 shrink-0 flex items-center justify-center border transition-colors rounded ${
                    done
                      ? "border-[var(--success)] bg-[color-mix(in_srgb,var(--success)_10%,transparent)] text-[var(--success)]"
                      : "border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
                  } ${!isCommitment ? "opacity-30 cursor-not-allowed" : ""}`}
                >
                  {saving === item.id
                    ? <Loader2 className="w-4 h-4 animate-spin" />
                    : done
                    ? <CheckCircle2 className="w-4 h-4" aria-hidden="true" />
                    : <Circle className="w-4 h-4" aria-hidden="true" />}
                </button>
                <div className="flex-1 min-w-0">
                  <p className={`text-sm leading-snug ${done ? "line-through text-[var(--text-muted)]" : "text-[var(--text-primary)]"}`}>
                    {item.text || item.label || item.title}
                  </p>
                  <div className="mt-1 flex items-center gap-2 flex-wrap text-xs text-[var(--text-muted)]">
                    {item.goal_title && (
                      <span className="px-1.5 py-0.5 border border-[var(--border)] rounded text-[var(--text-secondary)]">
                        {item.goal_title}
                      </span>
                    )}
                    {isTimedBlock && item.start_time && item.end_time && (
                      <span className="font-mono tabular-nums text-[var(--accent)]">{item.start_time}–{item.end_time}</span>
                    )}
                    {(item.due || item.start_date) && (
                      <span>{item.due || item.start_date}</span>
                    )}
                    {overdue && (
                      <span className="text-[var(--danger)] font-semibold">Overdue</span>
                    )}
                    {isCommitment && !overdue && item.due === todayKey && "Today"}
                  </div>
                </div>
              </div>

              {/* Action buttons — collapse into a single "Need help?" trigger
                  on mobile (sm+) shows both options inline; phones tap once
                  to reveal the two pre-fill chat intents. Same end-state
                  (opens the chat with the right prefill) just less chrome. */}
              {!done && !isTimedBlock && (
                <NeedHelpActions
                  item={item}
                  onCant={cantDoThis}
                  onAddToPlan={addToPlan}
                />
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* Iteration 7 (Ask 1) — per-tile free-text note + per-tile chat input
 * were removed. The single section-level "Tell the coach anything about
 * today" input now lives in `frontend/src/components/Today.jsx` and is
 * rendered once for the whole "Today · tasks" section.
 */

/**
 * NeedHelpActions — single tap-to-reveal trigger on mobile, both buttons
 * inline on sm+. Both surfaces drive the same `onCant` / `onAddToPlan`
 * callbacks; the difference is purely chrome.
 *
 * State machine: closed (chevron-down, hint visible) → open (chevron-up,
 * two buttons revealed). Click-outside + Esc close. Per-item state so
 * expanding one row doesn't accidentally expand all of them.
 */
function NeedHelpActions({ item, onCant, onAddToPlan }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={`need-help-${item._kind}-${item.id}`}
        data-testid={`timetable-need-help-${item.id}`}
        className="sm:hidden h-11 self-start inline-flex items-center gap-1.5 px-3 border border-[var(--border)] text-[var(--text-secondary)] text-xs transition-colors rounded hover:border-[var(--accent)] hover:text-[var(--accent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
      >
        {open ? <ChevronUp className="w-3.5 h-3.5" aria-hidden="true" /> : <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />}
        Need help with this?
      </button>
      <div
        id={`need-help-${item._kind}-${item.id}`}
        className={`${open ? "flex" : "hidden"} sm:flex flex-col sm:flex-row gap-2`}
      >
        <button
          type="button"
          onClick={() => { setOpen(false); onCant?.(item); }}
          data-testid={`timetable-cant-${item.id}`}
          className="h-11 inline-flex items-center gap-1.5 px-3 border border-[var(--border)] hover:border-[var(--danger)] hover:text-[var(--danger)] text-[var(--text-secondary)] text-xs transition-colors rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
        >
          <MessageSquareWarning className="w-3.5 h-3.5" aria-hidden="true" />
          I can't do this
        </button>
        <button
          type="button"
          onClick={() => { setOpen(false); onAddToPlan?.(item); }}
          data-testid={`timetable-plan-${item.id}`}
          className="h-11 inline-flex items-center gap-1.5 px-3 border border-[var(--border)] hover:border-[var(--accent)] hover:text-[var(--accent)] text-[var(--text-secondary)] text-xs transition-colors rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
        >
          <MessageSquarePlus className="w-3.5 h-3.5" aria-hidden="true" />
          Break it down with the coach
        </button>
      </div>
    </div>
  );
}
