import React, { useState } from "react";

/**
 * Unified add-to-day dialog — one flow instead of Blocker / Block /
 * Commitment. Pick what it is, a date, and either with-time or all-day.
 * Internally: with-time → a calendar block; all-day → a commitment;
 * "unavailable" → a blocker. Storybook mock for approval before wiring.
 */

export function AddToDayDialog() {
  const [what, setWhat] = useState("");
  const [kind, setKind] = useState("task"); // task | unavailable
  const [withTime, setWithTime] = useState(false);
  const [date, setDate] = useState("2026-10-12");
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("10:00");
  const [goalId, setGoalId] = useState("g1");

  const radio = (on) =>
    `flex-1 min-h-11 rounded-xl text-[13px] font-medium transition-colors ${
      on ? "bg-[var(--accent)] text-[var(--bg-primary)]" : "bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
    }`;

  return (
    <div className="mx-auto max-w-md bg-[var(--bg-secondary)] rounded-[18px] border border-[var(--border)] shadow-xl">
      <div className="flex items-start gap-3 border-b border-[var(--border)] px-5 py-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-[var(--text-primary)]">Add to Monday, 12 October</h2>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">One quick thing — set what it is and when.</p>
        </div>
      </div>

      <div className="space-y-4 px-5 py-4">
        <div>
          <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">What</label>
          <input
            value={what}
            onChange={(e) => setWhat(e.target.value)}
            placeholder="e.g. Draft target-role list"
            className="w-full rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
          />
        </div>

        <div>
          <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Type</label>
          <div className="flex gap-2">
            <button type="button" onClick={() => setKind("task")} className={radio(kind === "task")}>
              Thing to do
            </button>
            <button type="button" onClick={() => setKind("unavailable")} className={radio(kind === "unavailable")}>
              I&rsquo;m unavailable
            </button>
          </div>
        </div>

        <div>
          <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">When</label>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => setWithTime(false)} className={radio(!withTime)}>
              All day
            </button>
            <button type="button" onClick={() => setWithTime(true)} className={radio(withTime)}>
              At a time
            </button>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className={`rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2 text-sm text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none ${withTime ? "" : "col-span-2"}`}
            />
            {withTime && (
              <div className="grid grid-cols-2 gap-2">
                <input type="time" value={start} onChange={(e) => setStart(e.target.value)} className="rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2 text-sm text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none" />
                <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} className="rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2 text-sm text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none" />
              </div>
            )}
          </div>
        </div>

        {kind === "task" && (
          <div>
            <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Goal (optional)</label>
            <select
              value={goalId}
              onChange={(e) => setGoalId(e.target.value)}
              className="min-h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-sm text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
            >
              <option value="">Unlinked</option>
              <option value="g1">Switch to a new job in 3 months</option>
              <option value="g2">Ship side-project MVP</option>
            </select>
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] px-5 py-3">
        <button type="button" className="min-h-11 rounded-xl px-4 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
          Cancel
        </button>
        <button
          type="button"
          disabled={!what.trim()}
          className="min-h-11 rounded-xl bg-[var(--accent)] px-4 text-xs font-semibold text-[var(--bg-primary)] hover:opacity-90 disabled:opacity-50"
        >
          Add
        </button>
      </div>
    </div>
  );
}

export default {
  title: "Timeline/Add to day (unified)",
  parameters: { layout: "fullscreen" },
};

export const Unified = () => (
  <div className="bg-[var(--bg-primary)] p-6">
    <AddToDayDialog />
  </div>
);

export const WithTime = () => {
  const Frame = () => (
    <div className="bg-[var(--bg-primary)] p-6">
      <AddToDayDialog />
    </div>
  );
  return <Frame />;
};
