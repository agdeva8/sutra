import { useState, useEffect, useCallback } from "react";
import { Calendar, CheckCircle2, Circle, Loader2, RefreshCw, MoreHorizontal } from "lucide-react";
import { api } from "../lib/api";
import { localDateKey } from "../lib/utils";
import NeedHelpActions from "./NeedHelpActions";

/**
 * TodayTimetable — today's timed blocks, daily tasks, and blockers.
 *
 * Per-item controls:
 *   - Clickable circle checkbox → mark done (PATCH /api/plan-items/:id)
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
    // /api/state already carries blockers and timetable blocks; only fetch them separately when the
    // board has not loaded (or an older server omits them), instead of two extra requests per render.
    const fromState = Array.isArray(state?.blockers) && Array.isArray(state?.timetableBlocks);
    (fromState
      ? Promise.resolve([state.blockers, { blocks: state.timetableBlocks }])
      : Promise.all([api.blockers(), api.timetable()])
    )
      .then(([blockersRes, timetableRes]) => {
        const rawBlockers = Array.isArray(blockersRes)
          ? blockersRes
          : (blockersRes?.blockers || []);

        const todayKey = localDateKey();
        const todayBlockers = rawBlockers.filter(
          (b) => b.start_date === todayKey || (b.start_date <= todayKey && b.end_date >= todayKey),
        );
        // Today's daily plan tasks (from the multi-horizon lattice): anything
        // due today, or overdue while still open.
        const todayTasks = (state?.plan_items || []).filter(
          (p) =>
            p.horizon === "daily" &&
            (p.due_date === todayKey ||
              (p.due_date && p.due_date < todayKey && (p.status || "open") === "open") ||
              // A to-do with no goal and no day ("reply to Mohit") stays on Today until it is done.
              (!p.goal_id && !p.due_date && (p.status || "open") !== "done")),
        );
        const todayBlocks = (timetableRes?.blocks || []).filter(
          (block) => block.block_date === todayKey,
        );
        const merged = [
          ...todayBlocks.map((block) => ({ ...block, text: block.label, _kind: "block" })),
          ...todayBlockers.map((b) => ({ ...b, _kind: "blocker" })),
          ...todayTasks.map((p) => ({ ...p, text: p.title, _kind: "plan" })),
        ];
        // Timed blocks first in clock order; then blockers, then tasks
        // (overdue first).
        merged.sort((a, b) => {
          const rank = { block: 0, blocker: 1, plan: 2 };
          if (rank[a._kind] !== rank[b._kind]) return rank[a._kind] - rank[b._kind];
          if (a._kind === "block") return String(a.start_time).localeCompare(String(b.start_time));
          const aOver = a._kind === "plan" && !!a.due_date && a.due_date < todayKey;
          const bOver = b._kind === "plan" && !!b.due_date && b.due_date < todayKey;
          return aOver === bOver ? 0 : aOver ? -1 : 1;
        });
        setItems(merged);
      })
      .catch((err) => {
        console.error("Failed to load timetable items:", err);
        setError(err);
      })
      .finally(() => setLoading(false));
  }, [state]);

  useEffect(() => { refresh(); }, [refresh, state]);

  // The plan task a row stands for. A task is itself; a scheduled session is a timetable block whose
  // `source_id` points at the task it was made for, so ticking it ticks that task. Fixed commitments and
  // blockers have no task behind them and cannot be ticked.
  const taskFor = (item) => {
    if (item._kind === "plan") return item;
    if (item._kind === "block" && item.source_id) {
      return (state?.plan_items || []).find((p) => p.id === item.source_id) || null;
    }
    return null;
  };

  const toggleDone = async (row) => {
    const c = taskFor(row);
    if (!c) return;
    setSaving(row.id);
    const next = c.status === "done" ? "open" : "done";
    // Optimistic flip
    setItems((prev) =>
      prev.map((b) => (b.id === c.id && b._kind === "plan"
        ? { ...b, status: next }
        : b))
    );
    try {
      await api.updatePlanItem(c.id, { status: next });
      // Patch the board in place; a full GET /state after every tick cost ~3.5s and 50KB.
      onChange?.((prev) => ({
        ...prev,
        plan_items: (prev.plan_items || []).map((p) => (p.id === c.id ? { ...p, status: next } : p)),
      }));
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
    const title = item.text || item.title || "this task";
    onOpenChat?.(
      "",
      {
        scope: item._kind === "blocker" ? "blocker" : "plan",
        refId: item.id,
        kind: "plan_day",
        title: `Renegotiate "${title}"`,
        helperText:
          "What part feels off? Be specific — the coach will suggest a keep / shrink / drop.",
      },
    );
  };
  const addToPlan = (item) => {
    const title = item.text || item.title || "this task";
    onOpenChat?.(
      "",
      {
        scope: item._kind === "blocker" ? "blocker" : "plan",
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
          const isTask = item._kind === "plan";
          const isTimedBlock = item._kind === "block";
          const linkedTask = taskFor(item);
          const tickable = !!linkedTask;
          const done = tickable && linkedTask.status === "done";
          const overdue = isTask && item.due_date && item.due_date < todayKey;
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
                  disabled={!tickable || saving === item.id}
                  title={tickable ? undefined : "This is a fixed commitment, so there's nothing to tick off. Tasks you plan show a tick box."}
                  aria-label={!tickable ? `"${item.text || item.title}" is a fixed commitment and can't be ticked` : done ? `Mark "${item.text || item.title}" as not done` : `Mark "${item.text || item.title}" as done`}
                  aria-pressed={done}
                  data-testid={`timetable-checkbox-${item.id}`}
                  className={`mt-0.5 h-11 w-11 shrink-0 flex items-center justify-center border transition-colors rounded ${
                    done
                      ? "border-[var(--success)] bg-[color-mix(in_srgb,var(--success)_10%,transparent)] text-[var(--success)]"
                      : "border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
                  } ${!tickable ? "opacity-30 cursor-not-allowed" : ""}`}
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
                    {(item.due_date || item.due || item.start_date) && (
                      <span>{item.due_date || item.due || item.start_date}</span>
                    )}
                    {overdue && (
                      <span className="text-[var(--danger)] font-semibold">Overdue</span>
                    )}
                    {isTask && !overdue && item.due_date === todayKey && "Today"}
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
 *
 * The per-item "I can't do this" / "Break it down with the coach" pair now
 * lives in `components/NeedHelpActions.jsx` — the Plan tree's task rows show
 * the same affordance, so it can't drift between the two surfaces.
 */

