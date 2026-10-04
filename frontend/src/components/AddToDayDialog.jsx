import { useEffect, useState } from "react";
import { toast } from "sonner";
import CenteredDialog from "./CenteredDialog";
import { api } from "../lib/api";
import { localDateKey } from "../lib/utils";

/**
 * AddToDayDialog — the ONE add flow for the calendar's scheduling/constraint
 * concepts. Replaces the old Blocker / Time-block / Commitment trio (Hard
 * constraint #2: blockers + timetable blocks are direct CRUD, no coach
 * confirm; commitments are created directly from the calendar here just as
 * the old day planner did).
 *
 * Pick what it is and when:
 *   Thing to do  + all day    → a commitment (due date)
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

  const valid =
    what.trim() &&
    startDate &&
    (kind === "unavailable" || allDay
      ? true
      : start && end && start < end);

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
    try {
      if (kind === "unavailable") {
        await api.createBlocker({
          title: what.trim(),
          start_date: startDate,
          end_date: endDate || startDate,
          note: "",
        });
      } else if (allDay) {
        await api.createCommitment({
          text: what.trim(),
          due: startDate,
          goal_id: goalId || null,
        });
      } else {
        await api.createBlock({
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
          ? "Added a commitment"
          : "Added a time block",
      );
      onCreated?.();
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
            {saving ? "Adding…" : "Add"}
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
                className={field}
              />
              <input
                type="date"
                aria-label="Ends"
                min={startDate}
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className={field}
              />
            </div>
          ) : (
            <div className="space-y-2">
              <input
                type="date"
                aria-label="Date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className={field}
              />
              {timed && (
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="time"
                    aria-label="Start time"
                    value={start}
                    onChange={(e) => onStartChange(e.target.value)}
                    className={field}
                  />
                  <input
                    type="time"
                    aria-label="End time"
                    value={end}
                    onChange={(e) => setEnd(e.target.value)}
                    className={field}
                  />
                </div>
              )}
            </div>
          )}
        </div>

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
