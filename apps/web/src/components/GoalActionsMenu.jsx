import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  MoreVertical,
  Info,
  Pencil,
  Milestone,
  BookImage,
  FileText,
  Paperclip,
  Link2,
  PauseCircle,
  Trash2,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import GoalMemoryDialog from './GoalMemoryDialog';
import SourceActionDialog from './SourceActionDialog';
import { api } from '../lib/api';

/**
 * GoalActionsMenu — the per-goal action dropdown for the Plan workspace
 * header. Triggered by a "⋯" button next to the goal title, it is the ONE
 * affordance for everything you can do to the goal you're looking at.
 *
 * Not to be confused with `GoalMenu.js`, which is the app-wide *screen
 * navigation* dropdown (Home / Plan / Memories / Sources …). This one
 * acts on a single goal.
 *
 * ── Where each action actually goes ────────────────────────────────────
 * The app has no `api.updateGoal` / `api.dropGoal` client. Goal mutations
 * are **chat-mediated**: the coach proposes, the user confirms. So the
 * four identity-changing actions delegate to the shared
 * `ActionPromptModal` (owned by Coach.js, reached through `onAction`),
 * which collects a reason and opens a focused chat. Nothing in this file
 * calls a goal mutation directly — which is why pause/drop can never fire
 * on a single tap.
 *
 *   edit        -> onAction(goal, 'edit')      // the Add-goal dialog in edit mode, on the Goal screen
 *   milestone   -> onAction(goal, 'add_step')  // ActionPromptModal "Add a step"
 *   pause       -> onAction(goal, 'pause')     // ActionPromptModal "Pause X?"
 *   drop        -> onAction(goal, 'drop')      // ActionPromptModal "Drop X?"
 *   memories    -> GoalMemoryDialog (goal-scoped)   |  onOpenMemories
 *   sources     -> navigate to the Sources screen    |  onOpenSources
 *   attach      -> SourceActionDialog upload  -> POST /api/sources/upload
 *   link        -> SourceActionDialog link    -> POST /api/sources/link
 *
 * Every action above also accepts a parent-supplied handler; the internal
 * fallbacks exist so the menu is useful before/without Coach.js wiring.
 * Actions with no handler *and* no safe fallback render disabled rather
 * than silently doing nothing.
 */
function Row({ icon: Icon, label, testid, onSelect, disabled = false, tone }) {
  const toneClass =
    tone === 'danger'
      ? 'text-[var(--danger)] focus:text-[var(--danger)]'
      : tone === 'warning'
        ? 'text-[var(--warning)] focus:text-[var(--warning)]'
        : 'text-[var(--text-secondary)] focus:text-[var(--text-primary)]';
  return (
    <DropdownMenuItem
      data-testid={testid}
      disabled={disabled}
      onSelect={onSelect}
      className={
        'flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-[13px] transition-colors motion-reduce:transition-none ' +
        toneClass
      }
    >
      <Icon className='h-4 w-4 shrink-0' aria-hidden='true' />
      <span className='flex-1 whitespace-nowrap'>{label}</span>
    </DropdownMenuItem>
  );
}

export function GoalActionsMenu({
  goal,
  onAction,
  onDetails,
  onOpenMemories,
  onOpenSources,
  onUploadFile,
  onAddLink,
  onChanged,
  align = 'end',
  className = '',
}) {
  const navigate = useNavigate();
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [sourceMode, setSourceMode] = useState(null); // 'upload' | 'link' | null

  const goalId = goal?.id || '';
  const title = goal?.title || 'Goal';
  const hasGoal = !!goalId;

  // `onAction` is Coach.js' `openAction`: it opens the shared
  // ActionPromptModal confirmation. Without it there is no confirmation
  // path, so the destructive/disruptive rows stay disabled.
  const canAction = typeof onAction === 'function';
  const act = (type) => {
    if (canAction) onAction(goal, type);
  };

  // SourceActionDialog calls these as (file, goalId) / (url, goalId).
  // The parent's versions (Coach.js `uploadFile` / `addLink`) also refresh
  // app state and run the goal-boundary confirm cascade; the fallbacks are
  // the bare API calls the dialogs need to still work standalone.
  const doUpload = async (file, gid) => {
    const run =
      onUploadFile || ((f, id) => api.uploadSource(f, id || ''));
    const res = await run(file, gid || goalId);
    onChanged?.();
    return res;
  };
  const doAddLink = async (url, gid) => {
    const run =
      onAddLink || ((u, id) => api.addLink({ url: u, goal_id: id || '' }));
    const res = await run(url, gid || goalId);
    onChanged?.();
    return res;
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          data-testid='goal-actions-trigger'
          aria-label={`Actions for ${title}`}
          className={
            'inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] transition-colors motion-reduce:transition-none ' +
            className
          }
        >
          <MoreVertical className='h-4 w-4' aria-hidden='true' />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align={align}
          sideOffset={6}
          data-testid='goal-actions-content'
          className='min-w-[232px]'
        >
          <DropdownMenuLabel className='truncate px-2.5 py-1.5 text-[11px] font-mono uppercase tracking-wider text-[var(--text-muted)]'>
            {title}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />

          <Row
            icon={Info}
            label='Details'
            testid='goal-actions-details'
            disabled={typeof onDetails !== 'function'}
            onSelect={() => onDetails?.(goal)}
          />
          <Row
            icon={Pencil}
            label='Edit goal'
            testid='goal-actions-edit'
            disabled={!canAction || !hasGoal}
            onSelect={() => act('edit')}
          />
          <Row
            icon={Milestone}
            label='Add a milestone'
            testid='goal-actions-milestone'
            disabled={!canAction || !hasGoal}
            onSelect={() => act('add_step')}
          />

          <DropdownMenuSeparator />

          <Row
            icon={BookImage}
            label='Memories'
            testid='goal-actions-memories'
            disabled={!hasGoal}
            onSelect={() => (onOpenMemories ? onOpenMemories(goal) : setMemoryOpen(true))}
          />
          <Row
            icon={FileText}
            label='Sources'
            testid='goal-actions-sources'
            onSelect={() => (onOpenSources ? onOpenSources(goal) : navigate('/?panel=sources'))}
          />
          <Row
            icon={Paperclip}
            label='Attach a file'
            testid='goal-actions-attach'
            disabled={!hasGoal}
            onSelect={() => setSourceMode('upload')}
          />
          <Row
            icon={Link2}
            label='Add a link'
            testid='goal-actions-link'
            disabled={!hasGoal}
            onSelect={() => setSourceMode('link')}
          />

          <DropdownMenuSeparator />

          {/* Both of these open the shared ActionPromptModal confirmation —
              they never mutate anything on click. */}
          <Row
            icon={PauseCircle}
            label='Pause goal'
            testid='goal-actions-pause'
            tone='warning'
            disabled={!canAction || !hasGoal}
            onSelect={() => act('pause')}
          />
          <Row
            icon={Trash2}
            label='Drop goal'
            testid='goal-actions-drop'
            tone='danger'
            disabled={!canAction || !hasGoal}
            onSelect={() => act('drop')}
          />
        </DropdownMenuContent>
      </DropdownMenu>

      {memoryOpen ? (
        <GoalMemoryDialog
          open
          onClose={() => setMemoryOpen(false)}
          goalId={goalId}
          goalTitle={title}
          onSaved={() => onChanged?.()}
        />
      ) : null}

      {sourceMode ? (
        <SourceActionDialog
          open
          onClose={() => setSourceMode(null)}
          mode={sourceMode}
          goalId={goalId}
          goalTitle={title}
          onUploadFile={doUpload}
          onAddLink={doAddLink}
        />
      ) : null}
    </>
  );
}

export default GoalActionsMenu;
