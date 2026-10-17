import { useState } from "react";
import { toast } from "sonner";
import { api } from "../lib/api";
import { localDateKey } from "../lib/utils";
import { TODO_PRIORITIES, TODO_PRIORITY_NORMAL } from "../constants/calendarKinds";
import { MAX_TODO_CHARS, MAX_TODO_DESCRIPTION_CHARS } from "../constants/limits";

/**
 * Add or edit a to-do. Only the title is required; day, due-by time, priority, description and goal are
 * all optional. Adding goes to `POST /todos`, editing to `PATCH /todos/:id` (only the changed fields, a
 * cleared one sent as null) — both through the gateway, so each save is audited and undoable.
 */
const FIELD =
  "min-h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-[14px] text-[var(--text-primary)] focus:outline-none focus:border-[var(--border-accent)]";

const fromTodo = (t) => ({
  title: t?.title || "",
  day: t?.due_date ? String(t.due_date).slice(0, 10) : "",
  due_time: t?.due_time ? String(t.due_time).slice(0, 5) : "",
  priority: t?.priority || TODO_PRIORITY_NORMAL,
  description: t?.description || "",
  goal_id: t?.goal_id || "",
});

/** The body to send: everything set for a new to-do; only what changed (empty → null) for an edit. */
function payload(form, original) {
  const clean = { ...form, title: form.title.trim(), description: form.description.trim() };
  if (!original) return Object.fromEntries(Object.entries(clean).filter(([, v]) => v !== ""));
  const was = fromTodo(original);
  return Object.fromEntries(Object.entries(clean).filter(([k, v]) => v !== was[k]).map(([k, v]) => [k, v === "" ? null : v]));
}

/** True when the row being edited is a `TaskBlock` (a to-do filed after the move to `calendar_blocks`). */
const isBlockTodo = (t) => t?.block_kind === "task" && !!t?.todo;

/** The raw block behind a normalized to-do row, with the form's fields applied. */
function blockPayload(form, todo) {
  const { due_date, due_time, status, item_type, note, ...block } = todo;
  return {
    ...block,
    title: form.title.trim(),
    day: form.day || null,
    at: form.due_time || null,
    priority: form.priority || TODO_PRIORITY_NORMAL,
    description: form.description.trim(),
    goal_id: form.goal_id || null,
  };
}

export default function TodoForm({ todo = null, goals = [], onSaved, onCancel }) {
  const [form, setForm] = useState(() => fromTodo(todo));
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e?.target ? e.target.value : e }));
  const liveGoals = goals.filter((g) => g.status !== "dropped");

  const submit = async (e) => {
    e.preventDefault();
    if (!form.title.trim() || busy) return;
    const body = payload(form, todo);
    if (todo && Object.keys(body).length === 0) return onCancel?.();
    setBusy(true);
    try {
      let res;
      if (todo && isBlockTodo(todo)) res = await api.blocks.update(todo.id, { block: blockPayload(form, todo) });
      else res = todo ? await api.editTodo(todo.id, body) : await api.createTodo(body);
      if (!todo) setForm(fromTodo(null));
      onSaved?.(res?.plan_item, res?.block);
    } catch (err) {
      toast.error(typeof err?.message === "string" ? err.message : "Couldn't save that to-do.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} data-testid="todo-form" className="space-y-2.5 rounded-2xl bg-[var(--bg-secondary)] p-3">
      <input autoFocus value={form.title} onChange={set("title")} maxLength={MAX_TODO_CHARS} placeholder="What needs doing?" aria-label="To-do" className={FIELD} />
      <div className="grid grid-cols-[minmax(0,1fr)_7.5rem] gap-2">
        <input type="date" value={form.day} min={todo?.due_date && todo.due_date < localDateKey() ? undefined : localDateKey()} onChange={set("day")} aria-label="Day (optional)" className={FIELD} />
        <input type="time" value={form.due_time} onChange={set("due_time")} aria-label="Due by (optional)" className={FIELD} />
      </div>
      <div role="radiogroup" aria-label="Priority" className="grid grid-cols-3 gap-1 rounded-full bg-[var(--bg-primary)] p-1">
        {TODO_PRIORITIES.map((p) => (
          <button
            key={p.key}
            type="button"
            role="radio"
            aria-checked={form.priority === p.key}
            onClick={() => set("priority")(p.key)}
            className={`min-h-9 rounded-full text-[13px] font-medium ${form.priority === p.key ? "bg-[var(--bg-secondary)] shadow-sm" : "text-[var(--text-muted)]"}`}
            style={form.priority === p.key ? { color: p.color } : undefined}
          >
            {p.label}
          </button>
        ))}
      </div>
      {liveGoals.length > 0 && (
        <select value={form.goal_id} onChange={set("goal_id")} aria-label="Goal (optional)" className={FIELD}>
          <option value="">No goal</option>
          {liveGoals.map((g) => (
            <option key={g.id} value={g.id}>{g.title}</option>
          ))}
        </select>
      )}
      <textarea value={form.description} onChange={set("description")} maxLength={MAX_TODO_DESCRIPTION_CHARS} rows={2} placeholder="Notes (optional)" aria-label="Description (optional)" className={`${FIELD} py-2 resize-none`} />
      <div className="flex justify-end gap-2">
        {onCancel && <button type="button" onClick={onCancel} className="min-h-11 px-4 text-[13px] text-[var(--text-muted)]">Cancel</button>}
        <button type="submit" disabled={!form.title.trim() || busy} className="min-h-11 rounded-full bg-[var(--accent)] px-5 text-[13px] font-semibold text-[var(--bg-primary)] disabled:opacity-30">
          {busy ? "Saving…" : todo ? "Save" : "Add"}
        </button>
      </div>
    </form>
  );
}
