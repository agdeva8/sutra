import { useMemo, useState } from "react";
import { CheckCircle2, Circle, ListTodo, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { todoEvent } from "../lib/events";
import { listTodos, toggleDone, upsertBlock, upsertPlanItem, TODO_FILTERS, TODO_SORTS } from "../lib/todos";
import { localDateKey } from "../lib/utils";
import { cardSurface, TODO_PRIORITY_BY_KEY, TODO_PRIORITY_NORMAL } from "../constants/calendarKinds";
import TodoForm from "./TodoForm";

/**
 * Todos — the user's own list. Every to-do from anywhere (this screen, Today's "+ To-do", Scratch) lands
 * here. Not-done on top, done sunk to the bottom, struck through and still tickable back. Sort by due
 * date, priority or newest; filter optional. Tap a to-do to edit any of its fields.
 */
const DAY_FMT = { weekday: "short", day: "numeric", month: "short" };
const fmtDay = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, DAY_FMT);

function Chip({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`min-h-9 shrink-0 rounded-full border px-3 text-[12px] font-medium ${active ? "border-[var(--accent)] text-[var(--accent)]" : "border-[var(--border)] text-[var(--text-muted)]"}`}
    >
      {children}
    </button>
  );
}

export function TodoRow({ todo, goalTitle, onToggle, onEdit, saving }) {
  const e = todoEvent(todo, goalTitle);
  const todayKey = localDateKey();
  const overdue = !e.done && e.day && e.day < todayKey;
  const priority = todo.priority && todo.priority !== TODO_PRIORITY_NORMAL ? TODO_PRIORITY_BY_KEY[todo.priority]?.label : "";
  return (
    <li data-testid={`todo-${todo.id}`} className={`flex items-start gap-1 rounded-lg px-1.5 py-1.5 ${e.done ? "opacity-60" : ""}`} style={cardSurface(e.color, e.look)}>
      <button
        type="button"
        onClick={() => onToggle(todo)}
        disabled={saving}
        aria-pressed={e.done}
        aria-label={e.done ? `Mark "${todo.title}" as not done` : `Mark "${todo.title}" as done`}
        className={`h-11 w-11 shrink-0 flex items-center justify-center rounded-full ${e.done ? "text-[var(--success)]" : "text-[var(--text-muted)] hover:text-[var(--accent)]"}`}
      >
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : e.done ? <CheckCircle2 className="h-5 w-5" aria-hidden="true" /> : <Circle className="h-5 w-5" aria-hidden="true" />}
      </button>
      <button type="button" onClick={() => onEdit(todo)} className="min-h-11 min-w-0 flex-1 py-1.5 pr-2 text-left">
        <p className={`text-[14px] leading-5 ${e.done ? "line-through text-[var(--text-muted)]" : "text-[var(--text-primary)]"}`}>{todo.title}</p>
        <p className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-[var(--text-muted)]">
          {e.day && <span className={overdue ? "font-semibold text-[var(--danger)]" : ""}>{overdue ? "Overdue · " : ""}{fmtDay(e.day)}{e.dueTime ? ` by ${e.dueTime}` : ""}</span>}
          {priority && <span style={{ color: e.color }}>{priority} priority</span>}
          {goalTitle && <span>{goalTitle}</span>}
          {e.note && <span className="truncate max-w-full">{e.note}</span>}
        </p>
      </button>
    </li>
  );
}

export default function TodosScreen({ state, onChange }) {
  const [sort, setSort] = useState(TODO_SORTS[0].key);
  const [filter, setFilter] = useState(TODO_FILTERS[0].key);
  const [editing, setEditing] = useState(null); // null | "new" | a todo row
  const [savingId, setSavingId] = useState(null);
  const goals = useMemo(() => state?.goals || [], [state]);
  const goalTitle = useMemo(() => Object.fromEntries(goals.map((g) => [g.id, g.title])), [goals]);
  const todos = useMemo(() => listTodos(state?.plan_items, { blocks: state?.blocks, sort, filter }), [state, sort, filter]);
  const openCount = todos.filter((t) => t.status !== "done").length;

  const toggle = async (todo) => {
    setSavingId(todo.id);
    try {
      await toggleDone(todo, onChange);
    } catch (err) {
      toast.error(typeof err?.message === "string" ? err.message : "Couldn't update that to-do.");
    } finally {
      setSavingId(null);
    }
  };
  const saved = (row, block) => {
    if (block) onChange?.(upsertBlock(block));
    else if (row) onChange?.(upsertPlanItem(row));
    setEditing(null);
  };

  return (
    <div data-testid="todos-view" className="mx-auto w-full max-w-[820px] space-y-4 px-4 py-5 sm:px-6 sm:py-6">
      <header className="flex items-end justify-between gap-3">
        <div>
          <div className="inline-flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
            <ListTodo className="h-3 w-3 text-[var(--accent)]" aria-hidden="true" />
            <span>{openCount} to do</span>
          </div>
          <h2 className="font-display text-2xl font-semibold tracking-tight text-[var(--text-primary)] sm:text-3xl">To-dos</h2>
        </div>
        {editing !== "new" && (
          <button type="button" onClick={() => setEditing("new")} data-testid="todo-add" className="min-h-11 inline-flex items-center gap-1.5 rounded-full bg-[var(--accent)] px-4 text-[13px] font-semibold text-[var(--bg-primary)]">
            <Plus className="h-4 w-4" aria-hidden="true" />
            To-do
          </button>
        )}
      </header>

      {editing === "new" && <TodoForm goals={goals} onSaved={saved} onCancel={() => setEditing(null)} />}

      <div className="space-y-2">
        <div className="flex items-center gap-1.5 overflow-x-auto" role="group" aria-label="Sort">
          <span className="shrink-0 text-[11px] text-[var(--text-muted)]">Sort</span>
          {TODO_SORTS.map((s) => (
            <Chip key={s.key} active={sort === s.key} onClick={() => setSort(s.key)}>{s.label}</Chip>
          ))}
        </div>
        <div className="flex items-center gap-1.5 overflow-x-auto" role="group" aria-label="Filter">
          <span className="shrink-0 text-[11px] text-[var(--text-muted)]">Show</span>
          {TODO_FILTERS.map((f) => (
            <Chip key={f.key} active={filter === f.key} onClick={() => setFilter(f.key)}>{f.label}</Chip>
          ))}
        </div>
      </div>

      {todos.length === 0 ? (
        <p className="rounded-2xl bg-[var(--bg-secondary)] p-4 text-[13px] text-[var(--text-muted)]">
          No to-dos here. Add one, or drop it in Scratch — "buy milk tomorrow" lands on this list.
        </p>
      ) : (
        <ul className="space-y-1.5" role="list">
          {todos.map((t) =>
            editing?.id === t.id ? (
              <li key={t.id}>
                <TodoForm todo={t} goals={goals} onSaved={saved} onCancel={() => setEditing(null)} />
              </li>
            ) : (
              <TodoRow key={t.id} todo={t} goalTitle={goalTitle[t.goal_id] || ""} onToggle={toggle} onEdit={setEditing} saving={savingId === t.id} />
            ),
          )}
        </ul>
      )}
    </div>
  );
}
