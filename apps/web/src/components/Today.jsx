import { useState, useRef, useLayoutEffect, useMemo } from "react";
import { CalendarClock, CalendarDays, MessageSquare, Plus, Send, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { localDateKey } from "../lib/utils";
import { adjustQuota, toggleDone, upsertPlanItem } from "../lib/todos";
import { buildAgenda, dayKeys } from "../lib/agenda";
import { planItemEvent } from "../lib/events";
import { planningIsLive } from "../lib/goalPlanning";
import { monthTargetsFor, targetProgress, tasksInTarget, weekTargetsFor, weekTargetsInMonth } from "../lib/horizons";
import {
  TODAY_RANGE_DAY,
  TODAY_RANGE_WEEK,
  TODAY_RANGE_MONTH,
  TODAY_RANGES,
  TODAY_RANGE_STORAGE_KEY,
} from "../constants/todayRanges";
import { AgendaDay, AgendaWeek, MonthSummary, MonthTargets, RangeTabs, TodayTargets, WeekTargets } from "./TodayAgenda";
import TodoForm from "./TodoForm";

const DAYS_PER_WEEK = 7;

/** A target as its card draws it: the goal and row, its progress, and the daily tasks under it as Events. */
function targetRow(state, goal, item, extra = {}) {
  return {
    goal,
    item,
    progress: targetProgress(state, item),
    entries: tasksInTarget(state, item).map((p) => planItemEvent(p, goal.title)),
    ...extra,
  };
}

/** Active goals whose plan the server says is being written, minus any already carrying a card. */
const planningGoalsFor = (state, rows) =>
  (state?.goals || []).filter(
    (g) => g.status === "active" && planningIsLive(g) && !rows.some((r) => r.goal.id === g.id),
  );

/** The days a range covers: today; Monday to Sunday of this week; the 1st to the last of this month. */
function rangeKeys(range, now) {
  if (range === TODAY_RANGE_WEEK) {
    const monday = new Date(now);
    monday.setDate(now.getDate() - ((now.getDay() + DAYS_PER_WEEK - 1) % DAYS_PER_WEEK));
    return dayKeys(monday, DAYS_PER_WEEK);
  }
  if (range === TODAY_RANGE_MONTH) {
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    return dayKeys(first, new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate());
  }
  return [localDateKey(now)];
}

function readRange() {
  try {
    const v = window.localStorage.getItem(TODAY_RANGE_STORAGE_KEY);
    return TODAY_RANGES.some((r) => r.key === v) ? v : TODAY_RANGE_DAY;
  } catch {
    return TODAY_RANGE_DAY;
  }
}

/**
 * Today — the "Today" tab. Hosts:
 *   1. A greeting strip with the date + the section's CTA row (which used
 *      to live on the TrackerCard and is now duplicated here so the tab
 *      stands on its own).
 *   2. The dated items list (TodayTimetable rendered with `fullTimetable=true`).
 *   3. **ONE** section-level free-text input at the bottom — "Tell the
 *      coach anything about today" — that opens the chat with whatever
 *      the user typed. Per-item note + per-item chat input were
 *      removed from TodayTimetable in Iteration 7; this is the single
 *      place the user talks about the day as a whole.
 *
 * The bottom card stays collapsed if the user has nothing on today so
 * the empty state doesn't end with a half-empty input that looks
 * broken.
 */
export default function Today({ state, onChange, onOpenChat, onOpenTimeline }) {
  const [text, setText] = useState("");
  const [range, setRangeState] = useState(readRange);
  const [savingId, setSavingId] = useState(null);
  const setRange = (r) => {
    setRangeState(r);
    try {
      window.localStorage.setItem(TODAY_RANGE_STORAGE_KEY, r);
    } catch {
      /* a private window: the range just is not remembered */
    }
  };
  const byDay = useMemo(() => buildAgenda(state, rangeKeys(range, new Date())), [state, range]);
  const todayEntries = byDay[localDateKey()] || [];
  // The rungs above the days: this week's and this month's targets, and the tasks that meet them.
  const weekRows = useMemo(
    () => weekTargetsFor(state, new Date()).map(({ goal, item }) => targetRow(state, goal, item)),
    [state],
  );
  const monthRows = useMemo(
    () =>
      monthTargetsFor(state, new Date()).map(({ goal, item }) =>
        targetRow(state, goal, item, { weeks: weekTargetsInMonth(state, item) }),
      ),
    [state],
  );

  const [adding, setAdding] = useState(false);
  // Ticking a to-do, a task, or a session made for a task flips it in place: it stays listed, struck through.
  const toggle = async (entry) => {
    if (!entry.task) return;
    setSavingId(entry.task.id);
    try {
      await toggleDone(entry.task, onChange);
    } catch (err) {
      toast.error(typeof err?.message === "string" ? err.message : "Couldn't update that.");
    } finally {
      setSavingId(null);
    }
  };
  // A quota steps one day at a time; the day is the occurrence's own day, not block.day.
  const adjust = async (entry, delta) => {
    if (!entry.task) return;
    setSavingId(entry.task.id);
    try {
      await adjustQuota(entry.task, entry.day, delta, onChange);
    } catch (err) {
      toast.error(typeof err?.message === "string" ? err.message : "Couldn't update that.");
    } finally {
      setSavingId(null);
    }
  };
  // Both openers pass an empty prefill: the button already names the action and the task.
  const cantDo = (item) =>
    onOpenChat?.("", { scope: "plan", refId: item.id, kind: "plan_day", title: `Renegotiate "${item.title}"`, helperText: "What part feels off? Be specific — the coach will suggest a keep / shrink / drop." });
  const breakDown = (item) =>
    onOpenChat?.("", { scope: "plan", refId: item.id, kind: "plan_day", title: `Break down "${item.title}"`, helperText: "Describe the smallest concrete next step and the rough when." });
  const rowProps = { onToggle: toggle, onQuota: adjust, savingId, onCant: cantDo, onBreakDown: breakDown };

  const handleSend = (e) => {
    e?.preventDefault?.();
    const trimmed = text.trim();
    if (!trimmed) return;
    // Scoped to the day: the modal titles itself "About: Today (…)" and
    // carries kind/title to the server, so the coach knows this is about
    // today's plan rather than a free-for-all. The user's OWN text is
    // passed through — only canned prompts were dropped from scoped opens.
    onOpenChat?.(trimmed, {
      scope: "generic",
      kind: "plan_day",
      title: `Today (${localDateKey()})`,
      helperText: "Tell me anything about today — I'll fold it into the plan.",
    });
    setText("");
  };

  return (
    <div data-testid="today-view" className="px-4 sm:px-6 py-5 sm:py-6 space-y-5 max-w-[820px] mx-auto w-full">
      <header className="flex items-start justify-between gap-3">
        <div className="space-y-1 min-w-0">
          <div className="inline-flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
            <CalendarDays className="w-3 h-3 text-[var(--accent)]" aria-hidden="true" />
            <span>Today, {localDateKey()}</span>
          </div>
          <h2 className="font-display text-2xl sm:text-3xl font-semibold text-[var(--text-primary)] tracking-tight">
            What's on the docket?
          </h2>
          <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
            Tick off tasks as you finish them, or ask the coach to renegotiate / break one down. Each kind keeps its calendar look: goal sessions, reminders, repeating and fixed commitments, to-dos, milestones and time away.
          </p>
        </div>
        {/* The way across to the zoomable calendar. Today answers "what now"; this is
            how you look further out without hunting through the More menu. */}
        <button
          type="button"
          data-testid="today-open-timeline"
          onClick={onOpenTimeline}
          aria-label="Open the full timeline"
          title="Full timeline"
          className="shrink-0 h-11 w-11 inline-flex items-center justify-center rounded-full border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--accent)] hover:border-[var(--border-accent)] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
        >
          <CalendarClock className="h-4 w-4" aria-hidden="true" />
        </button>
      </header>

      <RangeTabs value={range} onChange={setRange} />

      {range === TODAY_RANGE_DAY && (
        <section className="space-y-3" data-testid="agenda-today">
          {/* The ladder upward: what today's tasks are for. Quiet lines, so the day stays the focus. */}
          <TodayTargets rows={weekRows} />
          {adding ? (
            <TodoForm
              goals={state?.goals || []}
              onSaved={(row) => {
                if (row) onChange?.(upsertPlanItem(row));
                setAdding(false);
              }}
              onCancel={() => setAdding(false)}
            />
          ) : (
            <button
              type="button"
              onClick={() => setAdding(true)}
              data-testid="todo-quick-add-open"
              className="min-h-11 inline-flex items-center gap-1.5 rounded-full border border-dashed border-[var(--border)] px-4 text-[13px] font-medium text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              To-do
            </button>
          )}
          <AgendaDay entries={todayEntries} empty="Nothing on today. Add a to-do, or drop anything in Scratch." {...rowProps} />
        </section>
      )}
      {range === TODAY_RANGE_WEEK && (
        <>
          <WeekTargets rows={weekRows} planningGoals={planningGoalsFor(state, weekRows)} {...rowProps} />
          <AgendaWeek byDay={byDay} {...rowProps} />
        </>
      )}
      {range === TODAY_RANGE_MONTH && (
        <>
          <MonthTargets rows={monthRows} planningGoals={planningGoalsFor(state, monthRows)} />
          <MonthSummary byDay={byDay} goals={state?.goals || []} />
        </>
      )}

      <SectionChatInput
        text={text}
        setText={setText}
        onSubmit={handleSend}
      />
    </div>
  );
}

/**
 * SectionChatInput — the single "tell the coach about today" input.
 * Lives below the timetable list so the user has one place to dump a
 * thought, ask a question, or kick off a planning conversation. Empty
 * when there are no items so the empty Today tab doesn't end with a
 * stranded half-filled input.
 */
function SectionChatInput({ text, setText, onSubmit }) {
  const taRef = useRef(null);

  useLayoutEffect(() => {
    const el = taRef.current;
    if (!el) return;
    // Iteration 9+ — the textarea is a slim single row while empty; the
    // long placeholder must not be measured into the height (Chrome
    // includes a wrapped placeholder in scrollHeight). Only grow once
    // the user has actually typed, up to the max-h-28 cap.
    if (!text) {
      el.style.height = "40px";
      return;
    }
    el.style.height = "auto";
    const next = Math.min(112, Math.max(40, el.scrollHeight));
    el.style.height = `${next}px`;
  }, [text]);
  return (
    <form
      onSubmit={onSubmit}
      data-testid="today-section-chat"
      className="rounded-2xl bg-[var(--bg-secondary)] p-4 space-y-2"
    >
      <label
        htmlFor="today-section-chat-input"
        className="font-medium inline-flex items-center gap-1.5 text-[12px] text-[var(--text-muted)]"
      >
        <Sparkles className="w-3.5 h-3.5 text-[var(--accent)]" aria-hidden="true" />
        Tell the coach anything about today
      </label>
      <div className="flex items-start gap-2">
        <textarea
          ref={taRef}
          id="today-section-chat-input"
          data-testid="today-section-chat-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              onSubmit(e);
            }
          }}
          rows={1}
          placeholder="Something about today…"
          aria-label="Tell the coach anything about today"
          className="flex-1 min-w-0 bg-[var(--bg-primary)] border border-[var(--border)] rounded-xl px-3 py-2 text-[14px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--border-accent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] resize-none overflow-y-auto"
          style={{ minHeight: "40px", maxHeight: "112px", height: "40px" }}
        />
        <button
          type="submit"
          disabled={!text.trim()}
          aria-label="Send to coach"
          className="h-11 px-4 inline-flex items-center gap-1.5 rounded-full bg-[var(--accent)] text-[var(--bg-primary)] text-[14px] font-semibold hover:opacity-90 disabled:opacity-30 transition-opacity shrink-0"
        >
          <Send className="w-4 h-4" aria-hidden="true" />
          Send
        </button>
      </div>
      <p className="hidden sm:inline-flex text-[11px] text-[var(--text-muted)] items-center gap-1">
        <MessageSquare className="w-3 h-3" aria-hidden="true" />
        ⌘/Ctrl + Enter to send
      </p>
    </form>
  );
}
