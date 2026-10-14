import { useState, useRef, useEffect } from "react";
import { Sparkles, Plus, MessageSquare, ArrowRight } from "lucide-react";
import AddGoalDialog from "./AddGoalDialog";
import GoalIntakeDialog from "./GoalIntakeDialog";
import { USE_AGENT_INTAKE } from "../constants/features";
import GoalBoard from "./GoalBoard";
// The indicator is its own module — TrackingDashboard is one of two surfaces
// that render it (Overview carries the other), so a single definition keeps
// the two readings of the week's load identical.
import OverCommitmentIndicator from "./OverCommitmentIndicator";

/**
 * TrackingDashboard — the Goal tab (`?panel=state`).
 *
 * The "see and edit your goals" surface: the week's over-commitment read and
 * the horizon-grouped list of goals. Each goal is a `GoalCard` carrying its
 * own actions (add step · refine · pause · memories · attach a source · drop),
 * plus the Add goal flow that creates the first one.
 *
 * The accountability tracker card deliberately does NOT live here. Overview
 * opens with it ("today at a glance"); rendering it on both surfaces made the
 * two tabs open with the same block and read as duplicates of each other.
 * Overview shows the tracker plus a READ-ONLY goals preview that links here;
 * this tab is the editable list.
 *
 * The list itself is `GoalBoard`, extracted so the goal cards have exactly one
 * definition.
 */

export default function TrackingDashboard({
  state,
  onPrefill = () => {},
  onAction = () => {},
  onUploadSource = () => {},
  onAddLink = () => {},
  onDeleteSource = () => {},
  onCreated = () => {},
  onOpenChat = () => {},
  autoAnswer = false,
  grillMe = false,
  isGuest = false,
  registerCloser = null,
  autoOpenAddGoal = false,
  onAutoOpenAddGoalHandled = () => {},
}) {
  const [addGoalOpen, setAddGoalOpen] = useState(false);
  // Latest step-back function from the AddGoalDialog. The dialog's
  // `onStepBack` prop overwrites this on every step change; the
  // closer we register calls THIS ref (not onClose directly), so a
  // back press from the chat step retreats to tiles (with category
  // still selected) instead of closing the dialog.
  const addGoalStepBackRef = useRef(() => closeAddGoalDialog());

  const visibleGoals = (state?.goals || []).filter((g) => g.status !== "dropped");
  const milestones = state?.milestones || [];

  // The first goal is the first step of the guide and cannot be skipped: with no goals the dialog
  // opens by itself and stays until a plan is confirmed.
  const firstGoalRequired = !!state && visibleGoals.length === 0;
  useEffect(() => {
    if (!firstGoalRequired) return;
    const t = setTimeout(() => setAddGoalOpen(true), 300);
    return () => clearTimeout(t);
  }, [firstGoalRequired]);

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

  const openAddGoalDialog = () => setAddGoalOpen(true);
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

      {/* The TrackerCard ("today at a glance") deliberately lives on Overview
          only. Rendering it here as well made this tab and Overview open with
          the same block, so the two read as duplicates of each other. This tab
          is the goal list; Overview is the landing. */}
      <OverCommitmentIndicator oc={state.over_commitment} />

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
            {!firstGoalRequired && <button
              data-testid="empty-state-open-chat"
              onClick={onOpenChat}
              className="min-h-11 inline-flex items-center justify-center gap-2 px-5 py-2.5 bg-[var(--bg-tertiary)] text-[var(--text-secondary)] text-sm font-medium hover:text-[var(--text-primary)] active:scale-[0.98] transition-[color,transform] duration-150 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-primary)]"
            >
              <MessageSquare className="h-4 w-4" aria-hidden="true" /> Or just chat with the coach
            </button>}
          </div>
        </div>
      ) : (
        <GoalBoard
          goals={visibleGoals}
          milestones={milestones}
          // `state` only reaches the board so a goal's plan tree can be
          // derived from its `plan_items` when the plan panel opens.
          state={state}
          onAction={onAction}
          onUploadSource={onUploadSource}
          onAddLink={onAddLink}
          onDeleteSource={onDeleteSource}
          onCreated={onCreated}
          onChanged={onCreated}
          onOpenChat={onOpenChat}
        />
      )}

      {/* Motivation / curated nudges moved to the Home tab (founder
          feedback) so the Goals tab is purely about the goals. */}

      {USE_AGENT_INTAKE ? (
        <GoalIntakeDialog open={addGoalOpen} onClose={closeAddGoalDialog} onCreated={onCreated} />
      ) : (
        <AddGoalDialog
          open={addGoalOpen}
          onClose={closeAddGoalDialog}
          required={firstGoalRequired}
          onStepBack={(fn) => { addGoalStepBackRef.current = fn; }}
          registerCloser={registerCloser}
          autoAnswer={autoAnswer}
          grillMe={grillMe}
          onUploadSource={onUploadSource}
          onAddLink={onAddLink}
          onDeleteSource={onDeleteSource}
          onGoalConfirmed={onCreated}
        />
      )}
    </div>
  );
}
