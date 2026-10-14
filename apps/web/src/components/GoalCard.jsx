import { useState } from "react";
import {
  CircleDot,
  PauseCircle,
  Plus,
  Pencil,
  Trash2,
  Pause,
  Milestone,
  Paperclip,
  FileText,
  Link2,
  ExternalLink,
  X,
  BookImage,
  ListTree,
} from "lucide-react";
import { api, sourceDownloadUrl } from "../lib/api";
import SourceActionDialog from "./SourceActionDialog";
import LinkPreviewDialog from "./LinkPreviewDialog";

/**
 * GoalCard — one editable goal: status, why, target, next action, its
 * milestone and source chips, and the row of identity actions
 * (refine · pause · memories · drop).
 *
 * "Add a step / milestone" deliberately has no button here: it duplicated
 * "refine" (both route to the same edit-goal confirmation), so the row reads
 * as four distinct actions rather than two that look different and do the
 * same thing.
 *
 * Moved out of TrackingDashboard so the legacy Goals panel and the Plan tab's
 * Goals view render the same card from one definition — a goal action that
 * worked on one screen and did nothing on the other was the alternative.
 * GoalBoard owns the list these cards sit in.
 */

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
  // Links use the rich LinkPreviewDialog (LLM extract + ask + browse); files
  // and delete keep the simpler SourceActionDialog.
  const [linkOpen, setLinkOpen] = useState(false);
  // Clicking an attached link opens the same dialog in "reopen" mode: page
  // quick-info + what the coach read + edit, instead of a raw new tab.
  const [exploringSource, setExploringSource] = useState(null);
  const openSource = (s) => {
    if (s.kind !== "link") return;
    setExploringSource(s);
    api
      .getSource(s.id)
      .then((full) => setExploringSource(full))
      .catch(() => {});
  };
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
        <IconBtn testid={`goal-link-${goal.id}`} title="Add a link as a source" onClick={() => setLinkOpen(true)}><Link2 className="w-3 h-3" /></IconBtn>
        {sources.length === 0 && (
          <span className="text-[10px] text-[var(--text-muted)] font-mono uppercase tracking-wider ml-1">attach a source</span>
        )}
      </div>
      {open && sources.length > 0 && (
        <div className="mt-1.5 space-y-1">
          {sources.map((s) => (
            <div key={s.id} className="flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
              {s.kind === "link" ? <Link2 className="w-3 h-3 shrink-0" /> : <FileText className="w-3 h-3 shrink-0" />}
              {s.kind === "link" ? (
                <button
                  type="button"
                  data-testid={`goal-view-source-${s.id}`}
                  onClick={() => openSource(s)}
                  title="What the coach read from this link"
                  className="truncate hover:text-[var(--accent)] flex items-center gap-1 min-h-11 text-left"
                >
                  {s.original_filename} <ExternalLink className="w-2.5 h-2.5" />
                </button>
              ) : (
                <a href={sourceDownloadUrl(s.id)} target="_blank" rel="noreferrer" className="truncate hover:text-[var(--accent)] flex items-center gap-1">
                  {s.original_filename} <ExternalLink className="w-2.5 h-2.5" />
                </a>
              )}
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
      <LinkPreviewDialog
        open={linkOpen}
        onClose={() => setLinkOpen(false)}
        title={goal.title ? `Add a link to "${goal.title}"` : "Add a link as a source"}
        goalContext={goal.title}
        onAttach={async (excerpt, linkUrl) => {
          await onAddLink(linkUrl, goal.id, { text: excerpt });
        }}
      />
      {/* Reopen an attached link — quick-info + what the coach read, no ask chat. */}
      <LinkPreviewDialog
        open={!!exploringSource}
        existingSource={exploringSource}
        showAsk={false}
        title={goal.title ? `Add a link to "${goal.title}"` : "Add a link as a source"}
        goalContext={goal.title}
        onClose={() => setExploringSource(null)}
        onSaved={() => setExploringSource(null)}
      />
    </div>
  );
}

export default function GoalCard({ goal, milestones, onAction, onUploadSource, onAddLink, onDeleteSource, onAddMemory, onOpenPlan }) {
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
        {/* Labelled, not icon-only — and sized to match the `memories`
            button beside it. As a bare 14px glyph this read as decoration
            rather than the way into the goal's plan. */}
        <button
          data-testid={`goal-plan-${goal.id}`}
          title="Show this goal's plan"
          aria-label={`Show the plan for ${goal.title}`}
          onClick={() => onOpenPlan?.(goal)}
          className="h-11 sm:h-10 px-2.5 inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] hover:border-[var(--accent)] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
        >
          <ListTree className="w-3 h-3" aria-hidden="true" />
          <span className="font-mono text-[10px] uppercase tracking-wider">plan</span>
        </button>
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
