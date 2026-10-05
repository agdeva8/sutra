import { useState, useRef, useEffect } from "react";
import { Sparkles, CircleDot, PauseCircle, CheckCircle2, Circle, Plus, Pencil, Trash2, Pause, Milestone, Paperclip, FileText, Link2, ExternalLink, X, MessageSquare, ArrowRight, BookImage } from "lucide-react";
import { sourceDownloadUrl } from "../lib/api";
import AddGoalDialog from "./AddGoalDialog";
import SourceActionDialog from "./SourceActionDialog";
import TrackerCard from "./TrackerCard";
import GoalMemoryDialog from "./GoalMemoryDialog";

const HORIZON_ORDER = ["weekly", "short", "medium", "long"];
const HORIZON_LABELS = {
  weekly: "This week",
  short: "Short-term · < 3 months",
  medium: "Medium-term · 3–12 months",
  long: "Long-term · 1–3 years",
};

const LEVEL_STYLES = {
  clear: { color: "var(--success)", label: "on track" },
  moderate: { color: "var(--accent)", label: "keep an eye on it" },
  high: { color: "var(--warning)", label: "stretched" },
  critical: { color: "var(--danger)", label: "too much on" },
};

const AREAS = ["Health", "Career", "Learning", "Relationship", "Finance", "Side project"];
// GOAL_CATEGORIES is now defined in AddGoalDialog.js — the dialog is the
// single source of truth for category tiles so we don't fragment the
// surface.

export function OverCommitmentIndicator({ oc }) {
  if (!oc) return null;
  const style = LEVEL_STYLES[oc.level] || LEVEL_STYLES.clear;
  return (
    <div
      data-testid="over-commitment-indicator"
      role="status"
      className="border p-4 rounded-md"
      style={{ borderColor: style.color, background: "color-mix(in srgb, " + style.color + " 8%, transparent)" }}
    >
      <div className="flex items-center gap-2 mb-2">
        <Sparkles className="w-4 h-4" style={{ color: style.color }} />
        <span className="text-xs font-semibold" style={{ color: style.color }}>Your week · {style.label}</span>
        <span className="ml-auto font-mono text-[10px] text-[var(--text-muted)]">
          {oc.active_goals} {oc.active_goals === 1 ? "goal" : "goals"}
        </span>
      </div>
      <p className="text-xs leading-relaxed text-[var(--text-primary)]">{oc.message}</p>
      {oc.conflicting?.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {oc.conflicting.map((c) => (
            <span key={c} className="font-mono text-[10px] px-1.5 py-0.5 border rounded" style={{ borderColor: style.color, color: style.color }}>{c}</span>
          ))}
        </div>
      )}
    </div>
  );
}

const STATUS_ICON = {
  active: <CircleDot className="w-3.5 h-3.5 text-[var(--accent)]" />,
  paused: <PauseCircle className="w-3.5 h-3.5 text-[var(--warning)]" />,
};

function IconBtn({ testid, title, onClick, children, "aria-label": ariaLabel }) {
  return (
    <button
      data-testid={testid}
      title={title}
      aria-label={ariaLabel || title}
      onClick={onClick}
      className="h-11 w-11 shrink-0 sm:h-8 sm:w-9 flex items-center justify-center rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
    >
      {children}
    </button>
  );
}

const TODAY = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; })();
const mileColor = (m) => {
  if (m.status === "done") return "var(--success)";
  const d = m.target_date ? new Date(m.target_date + "T00:00:00") : null;
  if (d && !isNaN(d.getTime()) && d < TODAY) return "var(--danger)";
  return "var(--warning)";
};

function MilestonesChip({ milestones }) {
  const [open, setOpen] = useState(false);
  if (!milestones.length) return null;
  const counts = { green: 0, amber: 0, red: 0 };
  milestones.forEach((m) => {
    const c = mileColor(m);
    counts[c.includes("success") ? "green" : c.includes("danger") ? "red" : "amber"]++;
  });
  return (
    <div className="mt-2">
      <button
        data-testid="milestones-chip"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={`milestones-list-${milestones[0]?.id ?? "x"}`}
        className="min-h-11 flex items-center gap-1.5 text-[11px] px-2.5 py-1.5 rounded-full border border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--border-accent)] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
      >
        <Milestone className="w-3 h-3" aria-hidden="true" /> {milestones.length} milestone{milestones.length === 1 ? "" : "s"}
        <span className="flex items-center gap-1 ml-0.5">
          {counts.green > 0 && <span className="flex items-center gap-0.5" style={{ color: "var(--success)" }}>●{counts.green}</span>}
          {counts.amber > 0 && <span className="flex items-center gap-0.5" style={{ color: "var(--warning)" }}>●{counts.amber}</span>}
          {counts.red > 0 && <span className="flex items-center gap-0.5" style={{ color: "var(--danger)" }}>●{counts.red}</span>}
        </span>
      </button>
      {open && (
        <div className="mt-1.5 space-y-1 pl-1">
          {milestones.map((m) => (
            <div key={m.id} className="flex items-center gap-1.5 text-[11px]">
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: mileColor(m) }} />
              <span className={m.status === "done" ? "line-through text-[var(--text-muted)]" : "text-[var(--text-secondary)]"}>{m.title}</span>
              {m.target_date && <span className="ml-auto font-mono text-[10px] text-[var(--text-muted)]">{m.target_date}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SourcesChip({ goal, sources, onUpload, onAddLink, onDelete }) {
  const [open, setOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState(null);
  const [dialogSource, setDialogSource] = useState(null);
  return (
    <div className="mt-1.5">
      <div className="flex items-center gap-1.5">
        {sources.length > 0 && (
          <button
            data-testid={`sources-chip-${goal.id}`}
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls={`sources-list-${goal.id}`}
            className="min-h-11 flex items-center gap-1.5 text-[11px] px-2.5 py-1.5 rounded-full border border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--border-accent)] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
          >
            <Paperclip className="w-3 h-3" aria-hidden="true" /> {sources.length} source{sources.length === 1 ? "" : "s"}
          </button>
        )}
        <IconBtn testid={`goal-upload-${goal.id}`} title="Attach a file to this goal" onClick={() => setDialogMode("upload")}><Plus className="w-3.5 h-3.5" /></IconBtn>
        <IconBtn testid={`goal-link-${goal.id}`} title="Add a link as a source" onClick={() => setDialogMode("link")}><Link2 className="w-3 h-3" /></IconBtn>
        {sources.length === 0 && (
          <span className="text-[10px] text-[var(--text-muted)] font-mono uppercase tracking-wider ml-1">attach a source</span>
        )}
      </div>
      {open && sources.length > 0 && (
        <div className="mt-1.5 space-y-1">
          {sources.map((s) => (
            <div key={s.id} className="flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
              {s.kind === "link" ? <Link2 className="w-3 h-3 shrink-0" /> : <FileText className="w-3 h-3 shrink-0" />}
              <a href={s.kind === "link" ? s.url : sourceDownloadUrl(s.id)} target="_blank" rel="noreferrer" className="truncate hover:text-[var(--accent)] flex items-center gap-1">
                {s.original_filename} <ExternalLink className="w-2.5 h-2.5" />
              </a>
              <button
                data-testid={`goal-delete-source-${s.id}`}
                onClick={() => { setDialogSource(s); setDialogMode("delete"); }}
                className="ml-auto min-h-11 min-w-11 inline-flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--danger)]"
                title="Remove this source"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      <SourceActionDialog
        open={!!dialogMode}
        onClose={() => { setDialogMode(null); setDialogSource(null); }}
        mode={dialogMode || "upload"}
        source={dialogSource}
        goalId={goal.id}
        goalTitle={goal.title}
        onUploadFile={onUpload}
        onAddLink={onAddLink}
        onDeleteSource={onDelete}
      />
    </div>
  );
}

function GoalCard({ goal, milestones, onAction, onUploadSource, onAddLink, onDeleteSource, onAddMemory }) {
  const goalMiles = milestones.filter((m) => m.goal_id === goal.id || m.goal_title === goal.title);
  const sources = goal.sources || [];
  return (
    <div data-testid={`goal-card-${goal.id}`} className="group p-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5">{STATUS_ICON[goal.status] || <CircleDot className="w-3.5 h-3.5 text-[var(--text-muted)]" />}</span>
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold text-[var(--text-primary)] leading-snug">{goal.title}</div>
          {goal.why && <div className="text-[13px] text-[var(--text-secondary)] mt-0.5 leading-relaxed">{goal.why}</div>}
          {goal.target_date && <div className="mt-1 text-[11px] font-medium text-[var(--accent)]">Target · {goal.target_date}</div>}
          {goal.next_action && (
            <div className="mt-2 text-[13px] text-[var(--text-secondary)]">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Next</span> {goal.next_action}
            </div>
          )}
          <MilestonesChip milestones={goalMiles} />
          <SourcesChip goal={goal} sources={sources} onUpload={onUploadSource} onAddLink={onAddLink} onDelete={onDeleteSource} />
        </div>
      </div>
      <div className="mt-2 pt-2 border-t border-[var(--border)] flex items-center gap-1">
        <IconBtn testid={`goal-add-step-${goal.id}`} title="Add a step / milestone" onClick={() => onAction(goal, "add_step")}><Milestone className="w-3.5 h-3.5" /></IconBtn>
        <IconBtn testid={`goal-edit-${goal.id}`} title="Refine or rename this goal" onClick={() => onAction(goal, "edit")}><Pencil className="w-3.5 h-3.5" /></IconBtn>
        <IconBtn testid={`goal-pause-${goal.id}`} title="Pause this goal" onClick={() => onAction(goal, "pause")}><Pause className="w-3.5 h-3.5" /></IconBtn>
        <button
          data-testid={`goal-add-memory-${goal.id}`}
          title="Attach a memory (photo or Instagram) to this goal"
          aria-label="Attach a memory (photo or Instagram) to this goal"
          onClick={() => onAddMemory(goal)}
          className="h-11 sm:h-10 px-2.5 inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] hover:border-[var(--accent)] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
        >
          <BookImage className="w-3 h-3" aria-hidden="true" />
          <span className="font-mono text-[10px] uppercase tracking-wider">memories</span>
        </button>
        <div className="ml-auto" />
        <IconBtn testid={`goal-drop-${goal.id}`} title="Drop this goal" onClick={() => onAction(goal, "drop")}><Trash2 className="w-3.5 h-3.5" /></IconBtn>
      </div>
    </div>
  );
}

export default function TrackingDashboard({
  state,
  onPrefill = () => {},
  onAction = () => {},
  onUploadSource = () => {},
  onAddLink = () => {},
  onDeleteSource = () => {},
  onCreated = () => {},
  onOpenChat = () => {},
  onOpenChatWith = () => {},
  onOpenToday = () => {},
  autoAnswer = false,
  grillMe = false,
  isGuest = false,
  registerCloser = null,
  autoOpenAddGoal = false,
  onAutoOpenAddGoalHandled = () => {},
}) {
  const [addGoalOpen, setAddGoalOpen] = useState(false);
  const [memoryGoal, setMemoryGoal] = useState(null); // { id, title } | null
  // Latest step-back function from the AddGoalDialog. The dialog's
  // `onStepBack` prop overwrites this on every step change; the
  // closer we register calls THIS ref (not onClose directly), so a
  // back press from the chat step retreats to tiles (with category
  // still selected) instead of closing the dialog.
  const addGoalStepBackRef = useRef(() => closeAddGoalDialog());

  const visibleGoals = (state?.goals || []).filter((g) => g.status !== "dropped");
  const milestones = state?.milestones || [];

  // First-visit auto-open: when there are zero goals AND the
  // localStorage sentinel is unset, surface the AddGoalDialog half a
  // second after paint so the user lands inside it instead of staring
  // at an empty dark panel. The sentinel sticks so a returning user
  // never gets re-surprised. `closeAddGoalDialog` writes the same
  // sentinel, so closing the dialog is enough to mark the user onboarded.
  useEffect(() => {
    if (!state) return;
    if (visibleGoals.length !== 0) return;
    try {
      if (localStorage.getItem("gc_first_visit_v1") === "done") return;
    } catch { return; }
    const t = setTimeout(() => setAddGoalOpen(true), 600);
    return () => clearTimeout(t);
  }, [state, visibleGoals.length]);

  // "Take me there → Add goal" from the general chat. Coach.js routes to
  // this screen with `autoOpenAddGoal=true`; open the dialog once on
  // arrival, then tell the parent we've consumed the signal.
  useEffect(() => {
    if (!autoOpenAddGoal) return;
    setAddGoalOpen(true);
    onAutoOpenAddGoalHandled();
  }, [autoOpenAddGoal, onAutoOpenAddGoalHandled]);

  // Register / deregister the AddGoalDialog's closer with Coach.js so
  // the global back button (mobile panel-back-arrow AND browser back)
  // closes the topmost layer instead of walking history / app exit.
  // The closer calls the dialog's step-back function (which knows
  // whether to retreat to tiles or fully close), so a back press
  // during chat step unwinds one layer without losing category state.
  useEffect(() => {
    if (!addGoalOpen || !registerCloser) return;
    return registerCloser(() => addGoalStepBackRef.current?.());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addGoalOpen, registerCloser]);

  if (!state) {
    return (
      <div data-testid="tracking-dashboard-loading" className="p-4 sm:p-6 space-y-6" aria-busy="true" aria-live="polite">
        <div>
          <div className="h-4 w-28 gc-skeleton" />
          <div className="h-3 w-64 gc-skeleton mt-1.5" />
        </div>
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="border border-[var(--border)] bg-[var(--bg-secondary)] p-3.5 rounded-md space-y-2.5">
              <div className="flex items-start gap-2.5">
                <div className="w-4 h-4 rounded-full gc-skeleton mt-0.5 shrink-0" />
                <div className="flex-1 space-y-2">
                  <div className="h-3.5 w-2/5 gc-skeleton" />
                  <div className="h-3 w-3/4 gc-skeleton" />
                </div>
              </div>
              <div className="h-2.5 w-28 gc-skeleton ml-6" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  const grouped = HORIZON_ORDER.map((h) => ({ horizon: h, goals: visibleGoals.filter((g) => g.horizon === h) })).filter((g) => g.goals.length > 0);

  const openAddGoalDialog = () => setAddGoalOpen(true);
  const openGoalMemory = (goal) => setMemoryGoal({ id: goal.id, title: goal.title });
  const closeAddGoalDialog = () => {
    setAddGoalOpen(false);
    try { localStorage.setItem("gc_first_visit_v1", "done"); } catch { /* ignore */ }
  };

  return (
    <div data-testid="tracking-dashboard" className="px-4 sm:px-6 py-5 sm:py-6 space-y-7 max-w-[820px] mx-auto w-full">
      <div className="flex items-end justify-between gap-3">
        <p className="text-[14px] text-[var(--text-secondary)] max-w-md leading-relaxed">
          Everything the coach is keeping track of for you.
        </p>
        {visibleGoals.length > 0 && (
          <button data-testid="add-goal-button" onClick={openAddGoalDialog} className="flex items-center gap-1.5 px-4 h-11 rounded-full bg-[var(--accent)] text-[var(--bg-primary)] text-sm font-semibold hover:opacity-90 transition-opacity shrink-0">
            <Plus className="w-4 h-4" /> Add goal
          </button>
        )}
      </div>

      <OverCommitmentIndicator oc={state.over_commitment} />

      <TrackerCard state={state} onOpenChat={onOpenChatWith} onOpenToday={onOpenToday} />

      {visibleGoals.length === 0 ? (
        <div data-testid="empty-state" className="rounded-2xl bg-[var(--bg-secondary)] p-8 sm:p-12 text-center">
          <div className="mx-auto h-14 w-14 rounded-full bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] flex items-center justify-center mb-4">
            <Sparkles className="h-7 w-7 text-[var(--accent)]" aria-hidden="true" />
          </div>
          <h3 className="text-xl font-bold tracking-tight text-[var(--text-primary)]">
            What's the first thing you want to sort out?
          </h3>
          <p className="mt-2 text-[15px] text-[var(--text-secondary)] max-w-md mx-auto leading-relaxed">
            Pick a category and the coach will propose a goal with milestones — you confirm it before anything gets saved.
          </p>
          <div className="mt-6 flex flex-col sm:flex-row flex-wrap items-stretch sm:items-center justify-center gap-3">
            <button
              data-testid="empty-state-add-goal"
              onClick={openAddGoalDialog}
              className="min-h-11 inline-flex items-center justify-center gap-2 px-5 py-2.5 bg-[var(--accent)] text-[var(--bg-primary)] font-semibold text-sm hover:opacity-90 active:scale-[0.98] transition-[opacity,transform] duration-150 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-primary)]"
            >
              <Plus className="h-4 w-4" aria-hidden="true" /> Add your first goal
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </button>
            <button
              data-testid="empty-state-open-chat"
              onClick={onOpenChat}
              className="min-h-11 inline-flex items-center justify-center gap-2 px-5 py-2.5 bg-[var(--bg-tertiary)] text-[var(--text-secondary)] text-sm font-medium hover:text-[var(--text-primary)] active:scale-[0.98] transition-[color,transform] duration-150 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-primary)]"
            >
              <MessageSquare className="h-4 w-4" aria-hidden="true" /> Or just chat with the coach
            </button>
          </div>
        </div>
      ) : (
        grouped.map((group) => (
          <div key={group.horizon} data-testid={`horizon-${group.horizon}`}>
            <div className="px-1 pb-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">{HORIZON_LABELS[group.horizon]}</div>
            <div className="rounded-2xl bg-[var(--bg-secondary)] overflow-hidden divide-y divide-[var(--border)]">
              {group.goals.map((g) => (
                <GoalCard key={g.id} goal={g} milestones={milestones} onAction={onAction} onUploadSource={onUploadSource} onAddLink={onAddLink} onDeleteSource={onDeleteSource} onAddMemory={openGoalMemory} />
              ))}
            </div>
          </div>
        ))
      )}

      {/* Motivation / curated nudges moved to the Home tab (founder
          feedback) so the Goals tab is purely about the goals. */}

      <AddGoalDialog
        open={addGoalOpen}
        onClose={closeAddGoalDialog}
        onStepBack={(fn) => { addGoalStepBackRef.current = fn; }}
        registerCloser={registerCloser}
        autoAnswer={autoAnswer}
        grillMe={grillMe}
        onUploadSource={onUploadSource}
        onAddLink={onAddLink}
        onDeleteSource={onDeleteSource}
        onGoalConfirmed={onCreated}
      />

      <GoalMemoryDialog
        open={!!memoryGoal}
        goalId={memoryGoal?.id}
        goalTitle={memoryGoal?.title}
        onClose={() => setMemoryGoal(null)}
        onSaved={() => { setMemoryGoal(null); onCreated?.(); }}
      />
    </div>
  );
}
