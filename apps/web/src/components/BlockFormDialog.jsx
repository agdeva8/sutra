import { useEffect, useState } from "react";
import CenteredDialog from "./CenteredDialog";
import { ALERT_OPTIONS, BLOCK_KINDS, KIND_META, WEEKDAYS } from "../constants/blockKinds";
import { localDateKey } from "../lib/utils";

/**
 * The one add / edit form for the four block kinds. Add is the same form with the kind picker open;
 * edit locks the kind (changing kind would orphan what undo needs to restore).
 *
 * Which fields appear follows the kind: an Event is a date plus optional times; a Task's time is
 * none (a list item), a single moment (`at`) or a range; Away is a date range; a Milestone is a
 * goal and a target date. Goal attach is offered on Event and Task, required on Milestone, and
 * hidden on Away. The payload matches contracts/blocks.py exactly.
 */
export default function BlockFormDialog({
  open,
  onClose,
  onSave,
  onDelete,
  editing = null,
  goals = [],
  defaultKind = "event",
  defaultDate,
  defaultStart,
  defaultEnd,
}) {
  const [kind, setKind] = useState(defaultKind);
  const [title, setTitle] = useState("");
  const [day, setDay] = useState("");
  const [allDay, setAllDay] = useState(true);
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("10:00");
  const [at, setAt] = useState("");
  const [taskTiming, setTaskTiming] = useState("none"); // none | at | range
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [goalId, setGoalId] = useState("");
  const [alertBefore, setAlertBefore] = useState("");
  const [weekdays, setWeekdays] = useState([]);
  const [note, setNote] = useState("");
  // Delete asks twice, inline — never a browser confirm. The first tap arms it; the second deletes.
  // Re-armed on every open/edit so a half-confirmed delete never carries to another block.
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  useEffect(() => {
    if (!open) setConfirmingDelete(false);
  }, [open, editing]);

  // Seed from the edit target, or from whatever the user just tapped on the board.
  useEffect(() => {
    if (!open) return;
    const b = editing;
    const key = localDateKey(defaultDate instanceof Date ? defaultDate : defaultDate ? new Date(defaultDate) : new Date());
    setKind(b?.block_kind || defaultKind);
    setTitle(b?.title || "");
    setDay(b?.day || key);
    setAllDay(!(b?.start && b?.end));
    setStart(b?.start || defaultStart || "09:00");
    setEnd(b?.end || defaultEnd || "10:00");
    setAt(b?.at || "");
    setTaskTiming(b?.start && b?.end ? "range" : b?.at ? "at" : "none");
    setStartDate(b?.start_date || key);
    setEndDate(b?.end_date || b?.start_date || key);
    setTargetDate(b?.target_date || key);
    setGoalId(b?.goal_id || "");
    setAlertBefore(b?.alert_before ?? "");
    setWeekdays(b?.repeat?.weekdays || []);
    setNote(b?.note || b?.description || "");
  }, [open, editing, defaultKind, defaultDate, defaultStart, defaultEnd]);

  const togglingDay = (i) => setWeekdays((prev) => (prev.includes(i) ? prev.filter((d) => d !== i) : [...prev, i].sort()));

  const invalidReason = !title.trim()
    ? "Say what it is to add it."
    : kind === "milestone" && !goalId
    ? "A milestone needs a goal to be a checkpoint on."
    : kind === "away" && endDate < startDate
    ? "The end date can't be before the start date."
    : kind === "task" && taskTiming === "range" && end <= start
    ? "The end time must be after the start time."
    : "";
  const valid = !invalidReason;

  const submit = () => {
    if (!valid) return;
    const id = editing?.id;
    const common = { id, title: title.trim(), goal_id: goalId || null };
    const alert = alertBefore === "" ? null : Number(alertBefore);
    const repeat = weekdays.length ? { weekdays } : null;
    let block;
    if (kind === "event") {
      block = {
        block_kind: "event",
        ...common,
        day,
        start: allDay ? null : start,
        end: allDay ? null : end,
        repeat,
        alert_before: alert,
        note: note.trim(),
      };
    } else if (kind === "task") {
      block = {
        block_kind: "task",
        ...common,
        day: day || null,
        start: taskTiming === "range" ? start : null,
        end: taskTiming === "range" ? end : null,
        at: taskTiming === "at" ? at || null : null,
        effort_hours: null,
        milestone_id: null,
        repeat,
        alert_before: alert,
        done: editing?.done || false,
        state: editing?.state || "open",
        description: note.trim(),
        why: editing?.why || "",
      };
    } else if (kind === "away") {
      block = {
        block_kind: "away",
        id,
        title: title.trim(),
        start_date: startDate,
        end_date: endDate || startDate,
      };
    } else {
      block = {
        block_kind: "milestone",
        ...common,
        goal_id: goalId, // required — checked above
        target_date: targetDate,
        parent_id: editing?.parent_id || null,
        hours: editing?.hours || 0,
        reached: editing?.reached || false,
      };
    }
    onSave?.(block);
    onClose?.();
  };

  // Delete is offered only for a saved block. The first tap arms the label; the second removes it.
  const requestDelete = () => {
    if (!editing) return;
    if (!confirmingDelete) { setConfirmingDelete(true); return; }
    onDelete?.(editing.id);
  };

  const radio = (on) =>
    `flex-1 min-h-11 rounded-xl px-2 text-[12px] font-medium transition-colors ${
      on ? "bg-[var(--accent)] text-[var(--bg-primary)]" : "bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
    }`;
  const field =
    "w-full min-h-11 rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] transition-colors";
  const label = "mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]";

  return (
    <CenteredDialog
      open={open}
      onClose={onClose}
      title={editing ? `Edit ${KIND_META[kind].label.toLowerCase()}` : "Add to your calendar"}
      subtitle={KIND_META[kind].hint}
      maxWidth="max-w-sm"
      testId="block-form"
      footer={
        <>
          {editing && onDelete && (
            <button type="button" data-testid="block-form-delete" onClick={requestDelete}
              aria-live="polite"
              className="mr-auto min-h-11 rounded-xl border border-[color-mix(in_srgb,var(--danger)_40%,transparent)] px-3 text-xs font-medium text-[var(--danger)] hover:bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] transition-colors">
              {confirmingDelete ? "Delete — tap again to confirm" : KIND_META[kind].deleteLabel}
            </button>
          )}
          <button type="button" onClick={onClose}
            className="min-h-11 rounded-xl bg-[var(--bg-tertiary)] px-4 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors">
            Cancel
          </button>
          <button type="button" data-testid="block-form-submit" onClick={submit} disabled={!valid}
            className="min-h-11 rounded-xl bg-[var(--accent)] px-4 text-xs font-semibold text-[var(--bg-primary)] hover:opacity-90 transition-opacity disabled:opacity-50">
            {editing ? "Save" : "Add"}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {!editing && (
          <div>
            <span className={label}>What is it</span>
            <div className="grid grid-cols-2 gap-2">
              {BLOCK_KINDS.map((k) => (
                <button key={k} type="button" data-testid={`block-kind-${k}`} aria-pressed={kind === k}
                  onClick={() => setKind(k)} className={radio(kind === k)}>
                  <span aria-hidden="true">{KIND_META[k].glyph} </span>
                  {KIND_META[k].label}
                </button>
              ))}
            </div>
          </div>
        )}

        <div>
          <label htmlFor="block-title" className={label}>What</label>
          <input id="block-title" data-testid="block-title" autoFocus value={title}
            onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="e.g. Dinner with Mohit" className={field} />
        </div>

        {kind === "event" && (
          <>
            <div>
              <span className={label}>When</span>
              <div className="flex gap-2">
                <button type="button" aria-pressed={allDay} onClick={() => setAllDay(true)} className={radio(allDay)}>All day</button>
                <button type="button" aria-pressed={!allDay} onClick={() => setAllDay(false)} className={radio(!allDay)}>At a time</button>
              </div>
            </div>
            <div className="space-y-2">
              <input type="date" aria-label="Date" value={day} onChange={(e) => setDay(e.target.value)} className={`${field} gc-native-datetime`} />
              {!allDay && (
                <div className="grid grid-cols-2 gap-2">
                  <input type="time" aria-label="Start time" value={start} onChange={(e) => setStart(e.target.value)} className={`${field} gc-native-datetime`} />
                  <input type="time" aria-label="End time" value={end} onChange={(e) => setEnd(e.target.value)} className={`${field} gc-native-datetime`} />
                </div>
              )}
            </div>
          </>
        )}

        {kind === "task" && (
          <>
            <div>
              <span className={label}>When</span>
              <div className="flex gap-2">
                {[["none", "No time"], ["at", "A moment"], ["range", "A range"]].map(([v, l]) => (
                  <button key={v} type="button" data-testid={`block-timing-${v}`} aria-pressed={taskTiming === v}
                    onClick={() => setTaskTiming(v)} className={radio(taskTiming === v)}>{l}</button>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <input type="date" aria-label="Date" value={day} onChange={(e) => setDay(e.target.value)} className={`${field} gc-native-datetime`} />
              {taskTiming === "at" && (
                <input type="time" aria-label="At time" value={at} onChange={(e) => setAt(e.target.value)} className={`${field} gc-native-datetime`} />
              )}
              {taskTiming === "range" && (
                <div className="grid grid-cols-2 gap-2">
                  <input type="time" aria-label="Start time" value={start} onChange={(e) => setStart(e.target.value)} className={`${field} gc-native-datetime`} />
                  <input type="time" aria-label="End time" value={end} onChange={(e) => setEnd(e.target.value)} className={`${field} gc-native-datetime`} />
                </div>
              )}
            </div>
          </>
        )}

        {kind === "away" && (
          <div>
            <span className={label}>Dates away</span>
            <div className="grid grid-cols-2 gap-2">
              <input type="date" aria-label="Starts" value={startDate}
                onChange={(e) => { setStartDate(e.target.value); if (endDate < e.target.value) setEndDate(e.target.value); }}
                className={`${field} gc-native-datetime`} />
              <input type="date" aria-label="Ends" min={startDate} value={endDate} onChange={(e) => setEndDate(e.target.value)} className={`${field} gc-native-datetime`} />
            </div>
          </div>
        )}

        {kind === "milestone" && (
          <div>
            <span className={label}>Target date</span>
            <input type="date" aria-label="Target date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} className={`${field} gc-native-datetime`} />
          </div>
        )}

        {(kind === "event" || kind === "task" || kind === "milestone") && (
          <div>
            <label htmlFor="block-goal" className={label}>
              Goal {kind === "milestone" ? "(required)" : "(optional)"}
            </label>
            <select id="block-goal" data-testid="block-goal" value={goalId} onChange={(e) => setGoalId(e.target.value)} className={field}>
              {kind !== "milestone" && <option value="">None</option>}
              {!goals.length && <option value="">(no goals yet)</option>}
              {goals.map((g) => (
                <option key={g.id} value={g.id}>{g.title}</option>
              ))}
            </select>
          </div>
        )}

        {(kind === "event" || kind === "task") && (
          <>
            <div>
              <span className={label}>Repeats</span>
              <div className="flex flex-wrap gap-1.5">
                {WEEKDAYS.map((w, i) => (
                  <button key={w} type="button" aria-pressed={weekdays.includes(i)} aria-label={w}
                    onClick={() => togglingDay(i)}
                    className={`h-10 w-11 rounded-full text-[11px] font-medium transition-colors ${
                      weekdays.includes(i) ? "bg-[var(--accent)] text-[var(--bg-primary)]" : "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
                    }`}>
                    {w}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label htmlFor="block-alert" className={label}>Alert</label>
              <select id="block-alert" data-testid="block-alert" value={alertBefore}
                onChange={(e) => setAlertBefore(e.target.value)} className={field}>
                {ALERT_OPTIONS.map((o) => (
                  <option key={String(o.value)} value={o.value ?? ""}>{o.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="block-note" className={label}>Note</label>
              <input id="block-note" value={note} onChange={(e) => setNote(e.target.value)}
                placeholder="Anything worth remembering" className={field} />
            </div>
          </>
        )}

        {invalidReason && title.trim() && (
          <p role="status" data-testid="block-form-reason" className="text-xs text-[var(--text-muted)]">{invalidReason}</p>
        )}
      </div>
    </CenteredDialog>
  );
}
