import { useEffect, useState } from "react";
import { toast } from "sonner";
import CenteredDialog from "./CenteredDialog";
import TimeWheelInput from "./TimeWheelInput";
import { api } from "../lib/api";
import { localDateKey } from "../lib/utils";
import { toTimetableRows } from "../lib/timetableRows";

/**
 * AddToDayDialog — the ONE add flow for the calendar's scheduling/constraint
 * concepts (Hard constraint #2: blockers + timetable blocks + user daily tasks
 * are direct CRUD, no coach confirm).
 *
 * Pick what it is and when:
 *   Thing to do  + all day    → a daily plan task (plan_items)
 *   Thing to do  + at a time  → a timetable block (focus)
 *   I'm unavailable           → a blocker over a date range
 */
export default function AddToDayDialog({
  open,
  onClose,
  date,
  state,
  onCreated,
  defaultKind = "task",
}) {
  const [what, setWhat] = useState("");
  const [kind, setKind] = useState(defaultKind); // "task" | "unavailable"
  const [allDay, setAllDay] = useState(true);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("10:00");
  const [goalId, setGoalId] = useState("");
  const [saving, setSaving] = useState(false);

  // Seed from the clicked day each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    const key = date
      ? localDateKey(date instanceof Date ? date : new Date(date))
      : localDateKey();
    setWhat("");
    setKind(defaultKind);
    setAllDay(true);
    setStartDate(key);
    setEndDate(key);
    setStart("09:00");
    setEnd("10:00");
    setGoalId("");
    setSaving(false);
  }, [open, date, defaultKind]);

  const goals = (state?.goals || []).filter((g) => g.status !== "dropped");
  const timed = kind === "task" && !allDay;

  // Why Add is off, in words: a disabled button with no explanation reads as broken.
  const invalidReason = !what.trim()
    ? "Say what it is to add it."
    : !startDate
    ? "Pick a date."
    : kind === "unavailable" && endDate && endDate < startDate
    ? "The end date can't be before the start date."
    : timed && !(start && end)
    ? "Pick a start and an end time."
    : timed && end <= start
    ? "The end time must be after the start time."
    : "";
  const valid = !invalidReason;

  // Existing blocks that overlap the new one (timed items only). Warns, never blocks: sometimes the
  // overlap is intended, and the user can still add it. The 4-kind rows are adapted at the door —
  // the check below stays written against the old row shape either way.
  const overlaps = timed && valid
    ? toTimetableRows(state?.blocks || state?.timetableBlocks || [], { from: startDate, to: startDate }).filter(
        (b) => b.block_date === startDate && String(b.start_time).slice(0, 5) < end && String(b.end_time).slice(0, 5) > start,
      )
    : [];

  const onStartChange = (value) => {
    setStart(value);
    // Keep the end after the start so the block never renders inverted.
    if (value && end && end <= value) {
      const [h, m] = value.split(":").map(Number);
      setEnd(`${String(Math.min(23, (h + 1) % 24)).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    }
  };

  const submit = async () => {
    if (!valid || saving) return;
    setSaving(true);
    let created = null;
    try {
      if (kind === "unavailable") {
        await api.createBlocker({
          title: what.trim(),
          start_date: startDate,
          end_date: endDate || startDate,
          note: "",
        });
      } else if (allDay) {
        await api.createPlanItem({
          title: what.trim(),
          due_date: startDate,
          goal_id: goalId || null,
        });
      } else {
        created = await api.createBlock({
          block_date: startDate,
          start_time: start,
          end_time: end,
          label: what.trim(),
          kind: "focus",
          goal_id: goalId || null,
          note: "",
        });
      }
      toast.success(
        kind === "unavailable"
          ? "Marked you unavailable"
          : allDay
          ? "Added a task"
          : "Added a time block",
      );
      // The server already returned the new block: add it to the board in place instead of re-reading
      // the whole state (~50KB) after every write. Anything else still refreshes.
      if (created && created.id && Array.isArray(state?.timetableBlocks)) {
        onCreated?.((prev) => ({ ...prev, timetableBlocks: [...(prev?.timetableBlocks || []), created] }));
      } else {
        onCreated?.();
      }
      onClose?.();
    } catch (e) {
      console.error("Failed to add to day", e);
      toast.error("Couldn't add that — try again.");
    } finally {
      setSaving(false);
    }
  };

  const radio = (on) =>
    `flex-1 min-h-11 rounded-xl px-3 text-[13px] font-medium transition-colors ${
      on
        ? "bg-[var(--accent)] text-[var(--bg-primary)]"
        : "bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
    }`;
  const field =
    "w-full min-h-11 rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] transition-colors";

  return (
    <CenteredDialog
      open={open}
      onClose={onClose}
      title="Add to your day"
      subtitle="One quick thing — say what it is and when."
      maxWidth="max-w-sm"
      testId="add-to-day"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="min-h-11 rounded-xl bg-[var(--bg-tertiary)] px-4 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="add-to-day-submit"
            onClick={submit}
            disabled={!valid || saving}
            className="min-h-11 rounded-xl bg-[var(--accent)] px-4 text-xs font-semibold text-[var(--bg-primary)] hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {saving ? "Adding…" : overlaps.length > 0 ? "Add anyway" : "Add"}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label
            htmlFor="add-to-day-what"
            className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]"
          >
            What
          </label>
          <input
            id="add-to-day-what"
            data-testid="add-to-day-what"
            autoFocus
            value={what}
            onChange={(e) => setWhat(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="e.g. Draft target-role list"
            className={field}
          />
        </div>

        <div>
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
            Type
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              data-testid="add-to-day-type-task"
              aria-pressed={kind === "task"}
              onClick={() => setKind("task")}
              className={radio(kind === "task")}
            >
              Thing to do
            </button>
            <button
              type="button"
              data-testid="add-to-day-type-unavailable"
              aria-pressed={kind === "unavailable"}
              onClick={() => setKind("unavailable")}
              className={radio(kind === "unavailable")}
            >
              I&rsquo;m unavailable
            </button>
          </div>
        </div>

        {kind === "task" && (
          <div>
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
              When
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                data-testid="add-to-day-allday"
                aria-pressed={allDay}
                onClick={() => setAllDay(true)}
                className={radio(allDay)}
              >
                All day
              </button>
              <button
                type="button"
                data-testid="add-to-day-timed"
                aria-pressed={!allDay}
                onClick={() => setAllDay(false)}
                className={radio(!allDay)}
              >
                At a time
              </button>
            </div>
          </div>
        )}

        <div>
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
            {kind === "unavailable" ? "Dates" : timed ? "Time" : "Date"}
          </span>
          {kind === "unavailable" ? (
            <div className="grid grid-cols-2 gap-2">
              <input
                type="date"
                aria-label="Starts"
                value={startDate}
                onChange={(e) => {
                  setStartDate(e.target.value);
                  if (endDate < e.target.value) setEndDate(e.target.value);
                }}
                className={`${field} gc-native-datetime`}
              />
              <input
                type="date"
                aria-label="Ends"
                min={startDate}
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className={`${field} gc-native-datetime`}
              />
            </div>
          ) : (
            <div className="space-y-2">
              <input
                type="date"
                aria-label="Date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className={`${field} gc-native-datetime`}
              />
              {timed && (
                <div className="grid grid-cols-2 gap-2">
                  <TimeWheelInput aria-label="Start time" value={start} onChange={onStartChange} className={field} />
                  <TimeWheelInput aria-label="End time" value={end} onChange={setEnd} className={field} />
                </div>
              )}
            </div>
          )}
        </div>

        {(invalidReason && (what.trim() || timed)) && (
          <p role="status" data-testid="add-to-day-reason" className="text-xs text-[var(--text-muted)]">
            {invalidReason}
          </p>
        )}
        {overlaps.length > 0 && (
          <p role="alert" data-testid="add-to-day-conflict" className="text-xs text-[var(--warning)]">
            Overlaps {overlaps.slice(0, 2).map((b) => `"${b.label}" (${String(b.start_time).slice(0, 5)}-${String(b.end_time).slice(0, 5)})`).join(" and ")}
            {overlaps.length > 2 ? ` and ${overlaps.length - 2} more` : ""}. You can still add it.
          </p>
        )}

        {kind === "task" && (
          <div>
            <label
              htmlFor="add-to-day-goal"
              className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]"
            >
              Goal (optional)
            </label>
            <select
              id="add-to-day-goal"
              data-testid="add-to-day-goal"
              value={goalId}
              onChange={(e) => setGoalId(e.target.value)}
              className={field}
            >
              <option value="">Unlinked</option>
              {goals.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.title}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
    </CenteredDialog>
  );
}
