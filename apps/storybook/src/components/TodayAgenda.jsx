import { CheckCircle2, Circle, Loader2 } from "lucide-react";
import { localDateKey } from "../lib/utils";
import { summarize } from "../lib/agenda";
import { EVENT_KIND } from "../lib/events";
import { cardSurface, goalColor, TODO_PRIORITY_BY_KEY, TODO_PRIORITY_NORMAL } from "../constants/calendarKinds";
import { TODAY_RANGES } from "../constants/todayRanges";
import NeedHelpActions from "./NeedHelpActions";

/**
 * The pieces of the Today tab's agenda: the range switch, a day's list, a week of days, a month summary
 * Presentational: entries are Events (`lib/events.js`) grouped by `lib/agenda.js`; the caller owns the tick.
 */

const WEEKDAY_FMT = { weekday: "short", day: "numeric", month: "short" };
const fmtDay = (key) => new Date(`${key}T00:00:00`).toLocaleDateString(undefined, WEEKDAY_FMT);
const fmtHours = (h) => `${Math.round(h * 10) / 10}h`;

/** Today / This week / This month, as a segmented control. */
export function RangeTabs({ value, onChange }) {
  return (
    <div role="tablist" aria-label="Range" className="grid grid-cols-3 gap-1 rounded-full bg-[var(--bg-secondary)] p-1" data-testid="today-range">
      {TODAY_RANGES.map((r) => (
        <button
          key={r.key}
          type="button"
          role="tab"
          aria-selected={value === r.key}
          onClick={() => onChange(r.key)}
          data-testid={`today-range-${r.key}`}
          className={`min-h-11 rounded-full text-[13px] font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] ${
            value === r.key ? "bg-[var(--bg-primary)] text-[var(--text-primary)] shadow-sm" : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          }`}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

/** One thing on a day, in its calendar kind's look. Tasks (and sessions with a task) carry a tick. */
export function AgendaRow({ entry, onToggle, saving, onCant, onBreakDown, compact = false }) {
  const tickable = !!entry.task;
  const label = entry.label || "";
  // A to-do says its priority when it is not the default one.
  const priority = entry.kind === EVENT_KIND.todo && entry.priority && entry.priority !== TODO_PRIORITY_NORMAL ? TODO_PRIORITY_BY_KEY[entry.priority]?.label : "";
  return (
    <li data-testid={`agenda-${entry.id}`} className="rounded-lg px-2.5 py-2" style={cardSurface(entry.color, entry.look)}>
      <div className="flex items-start gap-2">
        {tickable ? (
          <button
            type="button"
            onClick={() => onToggle?.(entry)}
            disabled={saving}
            aria-pressed={entry.done}
            aria-label={entry.done ? `Mark "${entry.title}" as not done` : `Mark "${entry.title}" as done`}
            className={`-my-1.5 -ml-1.5 h-11 w-11 shrink-0 flex items-center justify-center rounded-full ${entry.done ? "text-[var(--success)]" : "text-[var(--text-muted)] hover:text-[var(--accent)]"}`}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : entry.done ? <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> : <Circle className="h-4 w-4" aria-hidden="true" />}
          </button>
        ) : (
          <span aria-hidden="true" className="w-5 shrink-0 text-center text-[13px] leading-5" style={{ color: entry.color }}>
            {entry.glyph}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className={`text-[14px] leading-5 ${entry.done ? "line-through text-[var(--text-muted)]" : "text-[var(--text-primary)]"}`}>
            {entry.time && <span className="mr-1.5 font-mono tabular-nums text-[12px] text-[var(--text-secondary)]">{entry.kind === EVENT_KIND.todo ? `by ${entry.time}` : entry.time}{entry.end ? `–${entry.end}` : ""}</span>}
            {entry.title}
          </p>
          {!compact && (
            <p className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-[var(--text-muted)]">
              <span>{label}</span>
              {priority && <span style={{ color: entry.color }}>· {priority} priority</span>}
              {entry.goalTitle && <span>· {entry.goalTitle}</span>}
              {entry.note && <span>· {entry.note}</span>}
              {entry.overdue && <span className="font-semibold text-[var(--danger)]">· Overdue</span>}
            </p>
          )}
        </div>
      </div>
      {/* Goal actions belong to a goal's task only; a to-do is the user's own and has none. */}
      {!compact && entry.kind === EVENT_KIND.task && !entry.done && onCant && (
        <div className="mt-1 pl-9">
          <NeedHelpActions item={{ ...entry.task, _kind: "plan" }} onCant={onCant} onAddToPlan={onBreakDown} />
        </div>
      )}
    </li>
  );
}

/** A day's entries, or a quiet line when it is empty. */
export function AgendaDay({ entries, empty = "Nothing here.", ...rowProps }) {
  if (!entries.length) return <p className="px-1 py-2 text-[13px] text-[var(--text-muted)]">{empty}</p>;
  return (
    <ul className="space-y-1.5" role="list">
      {entries.map((e) => (
        <AgendaRow key={e.id} entry={e} saving={!!e.task && rowProps.savingId === e.task.id} {...rowProps} />
      ))}
    </ul>
  );
}

/** The week, day by day. Today is marked; past days are dimmed but kept, so the week reads whole. */
export function AgendaWeek({ byDay, ...rowProps }) {
  const todayKey = localDateKey();
  return (
    <div className="space-y-4" data-testid="agenda-week">
      {Object.entries(byDay).map(([k, entries]) => (
        <section key={k} className={k < todayKey ? "opacity-60" : ""} aria-label={fmtDay(k)}>
          <h3 className="mb-1.5 flex items-baseline gap-2 text-[12px] font-semibold text-[var(--text-secondary)]">
            {fmtDay(k)}
            {k === todayKey && <span className="rounded-full bg-[var(--accent)] px-1.5 text-[10px] text-[var(--bg-primary)]">Today</span>}
            <span className="ml-auto font-normal tabular-nums text-[var(--text-muted)]">{entries.length || ""}</span>
          </h3>
          <AgendaDay entries={entries} empty="Free." compact {...rowProps} />
        </section>
      ))}
    </div>
  );
}

/** The month in numbers: hours per goal, milestones due, reminders, to-dos and time away. */
export function MonthSummary({ byDay, goals }) {
  const s = summarize(byDay, goals);
  const stat = (n, label) => (
    <div className="rounded-xl bg-[var(--bg-secondary)] px-3 py-2.5">
      <p className="text-xl font-semibold tabular-nums text-[var(--text-primary)]">{n}</p>
      <p className="text-[11px] text-[var(--text-muted)]">{label}</p>
    </div>
  );
  return (
    <div className="space-y-5" data-testid="month-summary">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {stat(s.milestones.length, "milestones due")}
        {stat(s.reminders, "reminders")}
        {stat(`${s.todosDone}/${s.todosOpen + s.todosDone}`, "to-dos done")}
        {stat(s.awayCount, "times away")}
      </div>
      <section>
        <h3 className="mb-2 text-[12px] font-semibold text-[var(--text-secondary)]">Goals — hours done of planned</h3>
        {s.goalRows.length === 0 ? (
          <p className="text-[13px] text-[var(--text-muted)]">No goals yet.</p>
        ) : (
          <ul className="space-y-2.5" role="list">
            {s.goalRows.map((r) => (
              <li key={r.goal.id}>
                <div className="flex items-baseline justify-between gap-2 text-[13px]">
                  <span className="truncate text-[var(--text-primary)]">{r.goal.title}</span>
                  <span className="shrink-0 tabular-nums text-[var(--text-muted)]">{fmtHours(r.done)} / {fmtHours(r.planned)}</span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full" style={{ background: `color-mix(in srgb, ${goalColor(r.goal.id)} 18%, var(--bg-primary))` }}>
                  <div className="h-full rounded-full" style={{ width: `${r.planned ? Math.min(100, (r.done / r.planned) * 100) : 0}%`, background: goalColor(r.goal.id) }} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      {s.milestones.length > 0 && (
        <section>
          <h3 className="mb-2 text-[12px] font-semibold text-[var(--text-secondary)]">Milestones due</h3>
          <AgendaDay entries={s.milestones} compact />
        </section>
      )}
      {s.reminderTitles.length > 0 && (
        <section>
          <h3 className="mb-2 text-[12px] font-semibold text-[var(--text-secondary)]">Reminders</h3>
          <p className="text-[13px] text-[var(--text-secondary)]">{s.reminderTitles.join(" · ")}</p>
        </section>
      )}
    </div>
  );
}
