import { useState, useCallback, useEffect } from "react";
import { X, Plus, AlertOctagon, CheckCircle2, Circle, Milestone, Clock } from "lucide-react";
import CenteredDialog from "./CenteredDialog";
import AutoTextarea from "./AutoTextarea";
import AddToDayDialog from "./AddToDayDialog";
import { api } from "../lib/api";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const fmtDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const TODAY = (() => { const t = new Date(); t.setHours(0, 0, 0, 0); return t; })();

const mileColor = (m) => {
  if (m.status === "done") return "var(--success)";
  const d = m.target_date ? new Date(m.target_date + "T00:00:00") : null;
  if (d && !isNaN(d.getTime()) && d < TODAY) return "var(--danger)";
  return "var(--warning)";
};

const blockerCoversDay = (b, dayStart) => {
  if (!b.start_date || !b.end_date) return false;
  const bs = new Date(b.start_date + "T00:00:00");
  const be = new Date(b.end_date + "T00:00:00");
  be.setHours(23, 59, 59, 999);
  return dayStart >= bs && dayStart <= be;
};

/**
 * DayPlanner — the editable "daily timetable" panel for a single day.
 *
 * Shared by Timeline's calendar view (clicking a day opens this). Direct
 * CRUD for the scheduling/constraint concepts (Hard constraint #2):
 *   - Timetable blocks: time-boxed slots (focus / routine / commitment /
 *     blocker) with label, start/end time, note.
 *   - Blockers: multi-day unavailability.
 *   - Commitments: goal-linked tasks with a done toggle.
 *   - Milestones: read-only.
 *
 * Props:
 *   day       — the selected Date (or null → render nothing)
 *   state     — the dashboard state (commitments / blockers / milestones)
 *   onChange  — called after any mutation so the parent re-fetches state
 *   onClose   — close the panel
 */
export default function DayPlanner({ day, state, onChange = () => {}, onClose, embedded = false }) {
  const [blocks, setBlocks] = useState([]);
  const [saving, setSaving] = useState(false);
  // The single unified add flow (commitment / time block / blocker).
  const [addOpen, setAddOpen] = useState(false);

  // Block dialog
  const [blockDialogOpen, setBlockDialogOpen] = useState(false);
  const [editBlock, setEditBlock] = useState(null);
  const [blockLabel, setBlockLabel] = useState("");
  const [blockKind, setBlockKind] = useState("focus");
  const [blockStart, setBlockStart] = useState("09:00");
  const [blockEnd, setBlockEnd] = useState("10:00");
  const [blockNote, setBlockNote] = useState("");
  const [blockGoalId, setBlockGoalId] = useState("");

  // Blocker dialog
  const [blockerDialogOpen, setBlockerDialogOpen] = useState(false);
  const [editBlocker, setEditBlocker] = useState(null);
  const [blockerTitle, setBlockerTitle] = useState("");
  const [blockerStart, setBlockerStart] = useState("");
  const [blockerEnd, setBlockerEnd] = useState("");
  const [blockerNote, setBlockerNote] = useState("");

  const loadBlocks = useCallback(() => {
    api.timetable()
      .then((res) => setBlocks(res?.blocks || []))
      .catch(() => { /* offline — keep the last list */ });
  }, []);
  useEffect(() => { loadBlocks(); }, [loadBlocks]);

  if (!day) return null;

  const dateStr = fmtDate(day);
  const dayStart = new Date(day); dayStart.setHours(0, 0, 0, 0);
  const commitments = state?.commitments || [];
  const blockers = state?.blockers || [];
  const milestones = state?.milestones || [];
  const dayCommitments = commitments.filter((c) => c.due === dateStr);
  const dayBlockers = blockers.filter((b) => blockerCoversDay(b, dayStart));
  const dayBlocks = blocks
    .filter((b) => b.block_date === dateStr)
    .sort((a, b) => String(a.start_time || "").localeCompare(String(b.start_time || "")));

  // Plan tasks — per-day rows from the multi-horizon lattice (plan_items).
  // Marked by a "Fulfils …" note; commitments are the other daily rows.
  const planItems = state?.plan_items || [];
  const dayPlanTasks = planItems.filter(
    (i) => i.horizon === "daily" && (i.note || "").startsWith("Fulfils") && i.due_date === dateStr,
  );
  // A milestone due today that is ALREADY shown as a plan task's fulfilment is
  // not repeated as its own row (that was the duplicate in the day panel).
  const taskTitles = new Set(dayPlanTasks.map((t) => t.title));
  const dayMilestones = milestones.filter(
    (m) => m.target_date === dateStr && !taskTitles.has(m.title),
  );

  const hasItems =
    dayPlanTasks.length + dayMilestones.length + dayCommitments.length + dayBlockers.length + dayBlocks.length > 0;

  // --- blocks -------------------------------------------------------------
  const openEditBlock = (b) => {
    setEditBlock(b);
    setBlockDialogOpen(true);
    setBlockLabel(b.label || "");
    setBlockKind(b.kind || "focus");
    setBlockStart(b.start_time || "09:00");
    setBlockEnd(b.end_time || "10:00");
    setBlockNote(b.note || "");
    setBlockGoalId(b.goal_id || "");
  };
  const closeBlockDialog = () => { setEditBlock(null); setBlockDialogOpen(false); };
  const saveBlock = async () => {
    if (!blockLabel.trim() || !blockStart || !blockEnd) return;
    setSaving(true);
    try {
      const payload = { block_date: dateStr, start_time: blockStart, end_time: blockEnd, label: blockLabel.trim(), kind: blockKind, goal_id: blockGoalId || null, note: blockNote };
      if (editBlock) { setBlocks((prev) => prev.map((b) => (b.id === editBlock.id ? { ...b, ...payload } : b))); await api.updateBlock(editBlock.id, payload); }
      else { await api.createBlock(payload); }
      loadBlocks();
      onChange();
      closeBlockDialog();
    } catch (e) { console.error("Failed to save block", e); } finally { setSaving(false); }
  };
  const deleteBlock = async () => {
    if (!editBlock) return;
    const id = editBlock.id;
    setBlocks((prev) => prev.filter((b) => b.id !== id));
    closeBlockDialog();
    try { await api.deleteBlock(id); onChange(); } catch (e) { console.error(e); loadBlocks(); }
  };

  // --- blockers -----------------------------------------------------------
  const openEditBlocker = (b) => {
    setEditBlocker(b);
    setBlockerDialogOpen(true);
    setBlockerTitle(b.title || "");
    setBlockerStart(b.start_date || dateStr);
    setBlockerEnd(b.end_date || b.start_date || dateStr);
    setBlockerNote(b.note || "");
  };
  const closeBlockerDialog = () => { setEditBlocker(null); setBlockerDialogOpen(false); };
  const saveBlocker = async () => {
    if (!blockerTitle.trim() || !blockerStart) return;
    setSaving(true);
    try {
      const payload = { title: blockerTitle.trim(), start_date: blockerStart, end_date: blockerEnd || blockerStart, note: blockerNote };
      if (editBlocker) await api.updateBlocker(editBlocker.id, payload);
      else await api.createBlocker(payload);
      onChange();
      closeBlockerDialog();
    } catch (e) { console.error("Failed to save blocker", e); } finally { setSaving(false); }
  };
  const deleteBlocker = async () => {
    if (!editBlocker) return;
    setSaving(true);
    try { await api.deleteBlocker(editBlocker.id); onChange(); closeBlockerDialog(); }
    catch (e) { console.error(e); } finally { setSaving(false); }
  };

  // --- commitments --------------------------------------------------------
  const toggleCommitment = async (c) => {
    try {
      await api.updateCommitment(c.id, { status: c.status === "done" ? "open" : "done" });
      onChange();
    } catch (e) { console.error(e); }
  };
  const togglePlanTask = async (t) => {
    try {
      await api.updatePlanItem(t.id, { status: t.status === "done" ? "open" : "done" });
      onChange();
    } catch (e) { console.error(e); }
  };
  return (
    <>
      <div data-testid={`day-planner-${dateStr}`} className={embedded ? "space-y-3" : "rounded-2xl bg-[var(--bg-secondary)] p-4 space-y-3"}>
        {!embedded && (
        <div className="flex items-center justify-between">
          <h3 className="text-[15px] font-semibold text-[var(--text-primary)]">
            {MONTHS[day.getMonth()]} {day.getDate()}, {day.getFullYear()}
          </h3>
          <button
            onClick={onClose}
            aria-label="Close day details"
            className="h-11 w-11 -mr-2 inline-flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        )}

        <div className="space-y-2">
          {!hasItems && <p className="text-[13px] text-[var(--text-muted)]">Nothing on this day yet.</p>}

          {dayBlocks.map((b) => (
            <button
              key={b.id}
              type="button"
              data-testid={`detail-block-${b.id}`}
              onClick={() => openEditBlock(b)}
              className="w-full flex items-center gap-2.5 text-[13px] rounded-xl bg-[var(--bg-tertiary)] px-3 py-2.5 text-left hover:bg-[color-mix(in_srgb,var(--accent)_10%,var(--bg-tertiary))] transition-colors"
            >
              <Clock className="w-4 h-4 shrink-0 text-[var(--accent)]" />
              <span className="tabular-nums text-[12px] text-[var(--text-muted)] shrink-0">{b.start_time}–{b.end_time}</span>
              <span className="truncate flex-1 text-[var(--text-primary)]">{b.label}</span>
              <span className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] shrink-0">{b.kind}</span>
            </button>
          ))}

          {dayBlockers.map((b) => (
            <button
              key={b.id}
              type="button"
              data-testid={`detail-blocker-${b.id}`}
              onClick={() => openEditBlocker(b)}
              className="w-full flex items-center gap-2 text-[13px] text-[var(--danger)] bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] rounded-xl px-3 py-2.5 text-left hover:bg-[color-mix(in_srgb,var(--danger)_16%,transparent)] transition-colors"
            >
              <AlertOctagon className="w-4 h-4 shrink-0" />
              <span className="truncate flex-1">{b.title}</span>
              <span className="text-[11px] opacity-70 shrink-0">{b.start_date}{b.end_date && b.end_date !== b.start_date ? ` – ${b.end_date}` : ""}</span>
            </button>
          ))}

          {dayPlanTasks.length > 0 && (
            <p className="pt-1 text-[10px] font-mono uppercase tracking-wider text-[var(--text-muted)]">
              Today&rsquo;s plan
            </p>
          )}
          {dayPlanTasks.map((t) => {
            const goal = (state?.goals || []).find((g) => g.id === t.goal_id);
            const fulfils = (t.note || "").replace(/^Fulfils\s*/, "").split("·")[0].trim();
            const hours = ((t.note || "").match(/([\d.]+)h/) || [])[1];
            const done = t.status === "done";
            return (
              <div key={t.id} className="flex items-start gap-1.5">
                <button
                  type="button"
                  data-testid={`detail-plan-task-toggle-${t.id}`}
                  onClick={() => togglePlanTask(t)}
                  aria-pressed={done}
                  aria-label={done ? "Mark not done" : "Mark done"}
                  className="shrink-0 inline-flex items-center justify-center h-11 w-11 -ml-3"
                >
                  {done ? (
                    <CheckCircle2 className="w-5 h-5 text-[var(--success)]" />
                  ) : (
                    <Circle className="w-5 h-5 text-[var(--accent)]" />
                  )}
                </button>
                <div className="min-w-0 flex-1 pt-2.5">
                  <div className={done ? "line-through text-[var(--text-muted)] text-[13px] truncate" : "text-[var(--text-primary)] text-[13px] truncate"}>
                    {t.title}
                  </div>
                  <div className="text-[11px] leading-snug text-[var(--text-muted)]">
                    <span className="text-[var(--text-secondary)]">{goal ? goal.title : "—"}</span>
                    {fulfils ? <span> › fulfils &ldquo;{fulfils}&rdquo;</span> : null}
                    {hours ? <span> · {hours}h</span> : null}
                  </div>
                </div>
              </div>
            );
          })}

          {dayMilestones.map((m) => (
            <div key={m.id} className="flex items-center gap-2 text-[13px] px-1">
              <Milestone className="w-4 h-4 shrink-0" style={{ color: mileColor(m) }} />
              <span className="text-[var(--text-secondary)] truncate flex-1">{m.title || "Milestone"}</span>
              {m.status === "done" && <CheckCircle2 className="w-4 h-4 text-[var(--success)] shrink-0" />}
            </div>
          ))}

          {dayCommitments.map((c) => (
            <div key={c.id} className="flex items-center gap-1.5">
              <button
                type="button"
                data-testid={`detail-commitment-toggle-${c.id}`}
                onClick={() => toggleCommitment(c)}
                aria-pressed={c.status === "done"}
                aria-label={c.status === "done" ? "Mark not done" : "Mark done"}
                className="shrink-0 inline-flex items-center justify-center h-11 w-11 -ml-3"
              >
                {c.status === "done" ? (
                  <CheckCircle2 className="w-5 h-5 text-[var(--success)]" />
                ) : (
                  <Circle className="w-5 h-5 text-[var(--text-muted)]" />
                )}
              </button>
              <span className={c.status === "done" ? "line-through text-[var(--text-muted)] text-[13px] truncate flex-1" : "text-[var(--text-secondary)] text-[13px] truncate flex-1"}>
                {c.text}
              </span>
            </div>
          ))}

          <div className="pt-1">
            <button
              data-testid={`add-to-day-detail-${dateStr}`}
              onClick={() => setAddOpen(true)}
              className="min-h-11 w-full flex items-center justify-center gap-1.5 px-3 rounded-xl bg-[var(--accent)] text-[13px] font-semibold text-[var(--bg-primary)] hover:opacity-90 transition-opacity"
            >
              <Plus className="w-4 h-4" /> Add to this day
            </button>
          </div>
        </div>
      </div>

      {/* Block dialog */}
      <CenteredDialog
        open={blockDialogOpen}
        onClose={closeBlockDialog}
        title={editBlock ? "Edit block" : "Add a time block"}
        subtitle={dateStr}
        maxWidth="max-w-sm"
      >
        <div className="space-y-3">
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)] mb-1">Label *</label>
            <input
              data-testid="block-label-input"
              type="text"
              value={blockLabel}
              onChange={(e) => setBlockLabel(e.target.value)}
              placeholder="e.g. Deep work — draft proposal"
              className="w-full px-3 py-2 rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] transition-colors"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)] mb-1">Start *</label>
              <input data-testid="block-start-input" type="time" value={blockStart} onChange={(e) => setBlockStart(e.target.value)} className="w-full px-3 py-2 rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] transition-colors" />
            </div>
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)] mb-1">End *</label>
              <input data-testid="block-end-input" type="time" value={blockEnd} onChange={(e) => setBlockEnd(e.target.value)} className="w-full px-3 py-2 rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] transition-colors" />
            </div>
          </div>
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)] mb-1">Kind</label>
            <div className="grid grid-cols-4 gap-1.5">
              {["focus", "routine", "commitment", "blocker"].map((k) => (
                <button key={k} type="button" data-testid={`block-kind-${k}`} onClick={() => setBlockKind(k)} aria-pressed={blockKind === k} className={`h-10 rounded-xl text-[12px] font-medium capitalize transition-colors ${blockKind === k ? "bg-[var(--accent)] text-[var(--bg-primary)]" : "bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"}`}>
                  {k}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label htmlFor="block-goal-select" className="block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)] mb-1">Goal (optional)</label>
            <select
              id="block-goal-select"
              data-testid="block-goal-select"
              value={blockGoalId}
              onChange={(e) => setBlockGoalId(e.target.value)}
              className="min-h-11 w-full px-3 rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] transition-colors"
            >
              <option value="">Unlinked schedule block</option>
              {(state?.goals || [])
                .filter((g) => g.status !== "dropped")
                .map((g) => (
                  <option key={g.id} value={g.id}>{g.title}</option>
                ))}
            </select>
            <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">
              Link goal-related work so the coach can flag schedule conflicts.
            </p>
          </div>
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)] mb-1">Note</label>
            <AutoTextarea data-testid="block-note-input" value={blockNote} onChange={(e) => setBlockNote(e.target.value)} minRows={2} maxRows={4} placeholder="Optional details…" className="w-full px-3 py-2 rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] text-sm leading-[22px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]" />
          </div>
          <div className="flex gap-2 pt-1">
            {editBlock && (
              <button data-testid="block-delete-btn" onClick={deleteBlock} disabled={saving} className="min-h-11 px-3 rounded-xl text-xs border border-[color-mix(in_srgb,var(--danger)_40%,transparent)] text-[var(--danger)] hover:bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] transition-colors disabled:opacity-50">
                Remove
              </button>
            )}
            <div className="ml-auto flex gap-2">
              <button onClick={closeBlockDialog} disabled={saving} className="min-h-11 px-4 rounded-xl text-xs font-medium bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors">Cancel</button>
              <button data-testid="block-save-btn" onClick={saveBlock} disabled={saving || !blockLabel.trim() || !blockStart || !blockEnd} className="min-h-11 px-4 rounded-xl text-xs font-semibold bg-[var(--accent)] text-[var(--bg-primary)] hover:opacity-90 transition-opacity disabled:opacity-50">
                {saving ? "Saving…" : editBlock ? "Save" : "Add"}
              </button>
            </div>
          </div>
        </div>
      </CenteredDialog>

      {/* Blocker dialog */}
      <CenteredDialog
        open={blockerDialogOpen}
        onClose={closeBlockerDialog}
        title={editBlocker ? "Edit blocker" : "Add a blocker"}
        subtitle={dateStr}
        maxWidth="max-w-sm"
      >
        <div className="space-y-3">
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)] mb-1">Title *</label>
            <input data-testid="blocker-title-input" type="text" value={blockerTitle} onChange={(e) => setBlockerTitle(e.target.value)} placeholder="e.g. On vacation, Conference week" className="w-full px-3 py-2 rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] transition-colors" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)] mb-1">Start *</label>
              <input data-testid="blocker-start-input" type="date" value={blockerStart} onChange={(e) => setBlockerStart(e.target.value)} className="w-full px-3 py-2 rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] transition-colors" />
            </div>
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)] mb-1">End</label>
              <input data-testid="blocker-end-input" type="date" value={blockerEnd} onChange={(e) => setBlockerEnd(e.target.value)} className="w-full px-3 py-2 rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] transition-colors" />
            </div>
          </div>
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)] mb-1">Note</label>
            <AutoTextarea data-testid="blocker-note-input" value={blockerNote} onChange={(e) => setBlockerNote(e.target.value)} minRows={2} maxRows={4} placeholder="Optional details…" className="w-full px-3 py-2 rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] text-sm leading-[22px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]" />
          </div>
          <div className="flex gap-2 pt-1">
            {editBlocker && (
              <button data-testid="blocker-delete-btn" onClick={deleteBlocker} disabled={saving} className="min-h-11 px-3 rounded-xl text-xs border border-[color-mix(in_srgb,var(--danger)_40%,transparent)] text-[var(--danger)] hover:bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] transition-colors disabled:opacity-50">Remove</button>
            )}
            <div className="ml-auto flex gap-2">
              <button onClick={closeBlockerDialog} disabled={saving} className="min-h-11 px-4 rounded-xl text-xs font-medium bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors">Cancel</button>
              <button data-testid="blocker-save-btn" onClick={saveBlocker} disabled={saving || !blockerTitle.trim() || !blockerStart} className="min-h-11 px-4 rounded-xl text-xs font-semibold bg-[var(--accent)] text-[var(--bg-primary)] hover:opacity-90 transition-opacity disabled:opacity-50">
                {saving ? "Saving…" : editBlocker ? "Save" : "Add"}
              </button>
            </div>
          </div>
        </div>
      </CenteredDialog>

      {/* The ONE add flow — commitment / time block / unavailable range. */}
      <AddToDayDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        date={day}
        state={state}
        onCreated={onChange}
      />
    </>
  );
}
