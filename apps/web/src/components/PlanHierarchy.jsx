import { useState } from 'react';
import { Target, Flag, Check, Circle, ChevronRight, ChevronDown, ChevronLeft, Clock, Layers } from 'lucide-react';
import { paletteFor, shadeFor, PLAN_INK } from './planColors';
import NeedHelpActions from './NeedHelpActions';
import { isMilestoneDone } from '../lib/timetableRows';

/**
 * PlanHierarchy - the multi-horizon plan in the canonical vocabulary.
 *
 * PlanLadder is a NAVIGABLE tree (disclosure arrow per container).
 * Mobile: two-line rows (title; then short chip + dates + %), a STICKY
 * goal header, and a COLLAPSIBLE milestone overlay that starts closed on
 * phones. Desktop (>=sm) keeps the one-line row with the progress bar.
 *
 * a11y: aria-expanded, keyboard, visible focus, 44px targets, reduced-motion.
 */

export const LEVELS = [
  { id: 'year', label: 'Year Plan', short: 'Year' },
  { id: 'quarter', label: 'Quarterly Plan', short: 'Quarter' },
  { id: 'month', label: 'Monthly Plan', short: 'Month' },
  { id: 'week', label: 'Weekly Plan', short: 'Week' },
  { id: 'day', label: 'Daily Task', short: 'Task' },
  { id: 'block', label: 'Time Block', short: 'Block' },
];

const NEST = { year: 0, quarter: 1, month: 2, week: 3, day: 4, block: 4 };
function nestDepth(id) { return NEST[id] === undefined ? 4 : NEST[id]; }
function level(id) { return LEVELS.find((x) => x.id === id) || LEVELS[3]; }

const STYLE = {
  year: { dot: 'bg-[var(--accent)]', chip: 'border-[var(--accent)] text-[var(--accent)]' },
  quarter: { dot: 'bg-[color-mix(in_srgb,var(--accent)_60%,transparent)]', chip: 'border-[var(--border-accent)] text-[var(--text-primary)]' },
  month: { dot: 'bg-[color-mix(in_srgb,var(--accent)_45%,transparent)]', chip: 'border-[var(--border)] text-[var(--text-secondary)]' },
  week: { dot: 'bg-[color-mix(in_srgb,var(--accent)_28%,transparent)]', chip: 'border-[var(--border)] text-[var(--text-secondary)]' },
  day: { dot: 'bg-[var(--accent)]', chip: 'border-[var(--border)] text-[var(--text-muted)]' },
  block: { dot: 'bg-[var(--text-muted)]', chip: 'border-[var(--border)] text-[var(--text-muted)]' },
};

export function cx() {
  const out = [];
  for (let i = 0; i < arguments.length; i += 1) if (arguments[i]) out.push(arguments[i]);
  return out.join(' ');
}

export function LevelChip({ level: lid, short = false, shade }) {
  const l = level(lid);
  const s = STYLE[lid] || STYLE.week;
  return (
    <span
      className={cx('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[12px] uppercase tracking-wider whitespace-nowrap', !shade && s.chip)}
      style={shade ? { backgroundColor: shade, color: PLAN_INK, borderColor: 'transparent' } : undefined}
    >
      <span aria-hidden='true' className={cx('w-1.5 h-1.5 rounded-full', s.dot)} />{short ? l.short : l.label}
    </span>
  );
}

export function ProgressBar({ value, label }) {
  const pct = Math.max(0, Math.min(100, Math.round(value || 0)));
  return (
    <div className='flex items-center gap-2 min-w-[110px]'>
      <div role='progressbar' aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label || 'progress'}
        className='h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--bg-primary)]'>
        <div className='h-full rounded-full bg-[var(--accent)] transition-[width] motion-reduce:transition-none' style={{ width: pct + '%' }} />
      </div>
      <span className='w-8 text-right text-[12px] font-mono tabular-nums text-[var(--text-muted)]'>{pct}%</span>
    </div>
  );
}

function fmt(iso) {
  if (!iso) return '';
  const d = new Date(String(iso).slice(0, 10) + 'T00:00:00.000Z');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function span(a, b) {
  if (!a && !b) return '';
  if (!b || b === a) return fmt(a);
  return fmt(a) + ' \u2013 ' + fmt(b);
}

export function buildTree(flat) {
  const roots = [];
  const stack = [];
  for (const n of flat) {
    const node = Object.assign({}, n, { children: [] });
    const d = nestDepth(n.level);
    while (stack.length && nestDepth(stack[stack.length - 1].level) >= d) stack.pop();
    if (stack.length) stack[stack.length - 1].children.push(node);
    else roots.push(node);
    stack.push(node);
  }
  return roots;
}

export function MilestoneOverlay({ milestones = [], defaultOpen, onItemClick }) {
  const [open, setOpen] = useState(() => {
    if (defaultOpen !== undefined) return defaultOpen;
    if (typeof window === 'undefined' || !window.matchMedia) return true;
    try { return window.matchMedia('(min-width: 640px)').matches; } catch (e) { return true; }
  });
  if (milestones.length === 0) return null;
  const doneCount = milestones.filter((m) => isMilestoneDone(m)).length;
  return (
    <div data-testid='milestone-overlay' className='rounded-lg border border-[var(--border-accent)] bg-[var(--bg-secondary)]'>
      <button type='button' aria-expanded={open} onClick={() => setOpen((v) => !v)} data-testid='milestone-toggle'
        className='flex min-h-11 w-full items-center gap-2 rounded-lg px-3 py-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]'>
        <Flag className='h-3 w-3 shrink-0 text-[var(--accent)]' aria-hidden='true' />
        <span className='text-[12px] font-mono uppercase tracking-wider text-[var(--text-muted)]'>Milestones</span>
        <span className='text-[12px] font-mono tabular-nums text-[var(--text-muted)]'>{doneCount + '/' + milestones.length}</span>
        <span className='ml-auto text-[12px] text-[var(--text-muted)]'>{open ? 'Hide' : 'Show'}</span>
        <ChevronDown className={cx('h-3.5 w-3.5 shrink-0 text-[var(--text-muted)] transition-transform motion-reduce:transition-none', !open && '-rotate-90')} aria-hidden='true' />
      </button>
      {open ? (
        <ul className='flex flex-wrap gap-1.5 px-3 pb-3'>
          {milestones.map((m) => (
            <li key={m.id}>
              <button type='button' data-testid={'milestone-chip-' + m.id} onClick={() => onItemClick && onItemClick(m)}
                className={cx('inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px]', isMilestoneDone(m) ? 'border-[var(--border)] text-[var(--text-muted)] line-through' : 'border-[var(--accent)] text-[var(--text-primary)] hover:brightness-105')}>
                <Flag className='h-3 w-3 shrink-0 text-[var(--accent)]' aria-hidden='true' />
                <span className='truncate'>{m.title}</span>
                <span className='shrink-0 font-mono text-[12px] text-[var(--text-muted)]'>{fmt(m.target_date)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function TreeRow({ node, depth, expanded, onToggle, onTask, palette, onItemClick, onHelp }) {
  const bg = shadeFor(palette, node.level);
  const kids = node.children || [];
  const hasKids = kids.length > 0;
  const isOpen = expanded.has(node.id);
  const isDay = node.level === 'day';
  const isBlock = node.level === 'block';
  const deep = isDay || isBlock;
  const pct = Math.max(0, Math.min(100, Math.round(node.progress || 0)));
  const when = span(node.start_date, node.end_date);
  const titleCls = cx('min-w-0 flex-1 break-words text-[14px] leading-snug text-[var(--text-primary)] sm:truncate sm:leading-tight', node.done && !hasKids && 'text-[var(--text-muted)] line-through', deep && 'text-[13px] sm:text-[14px]');
  return (
    <li>
      <div style={{ paddingLeft: 6 + depth * 12, borderLeft: '4px solid ' + bg }}
        className={cx('flex items-start gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] pr-2 transition-colors motion-reduce:transition-none hover:border-[var(--border-accent)] sm:items-center sm:pr-2.5', deep ? 'py-1' : 'py-1.5 sm:py-2')}>
        {hasKids ? (
          <button type='button' data-testid={'toggle-' + node.id} aria-expanded={isOpen}
            aria-label={(isOpen ? 'Collapse ' : 'Expand ') + node.title} onClick={() => onToggle(node.id)}
            className='flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-primary)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]'>
            <ChevronRight className={cx('h-4 w-4 transition-transform motion-reduce:transition-none', isOpen && 'rotate-90')} aria-hidden='true' />
          </button>
        ) : isDay ? (
          <button type='button' onClick={() => onTask && onTask(node.id)} aria-pressed={!!node.done} disabled={!onTask}
            aria-label={(node.done ? 'Mark not done: ' : 'Mark done: ') + node.title}
            className='flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-[var(--accent)] hover:bg-[var(--bg-primary)] disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]'>
            {node.done ? <Check className='h-4 w-4' aria-hidden='true' /> : <Circle className='h-4 w-4 opacity-50' aria-hidden='true' />}
          </button>
        ) : isBlock ? (
          <span className='flex h-11 w-11 shrink-0 items-center justify-center'><Clock className='h-3.5 w-3.5 text-[var(--text-muted)]' aria-hidden='true' /></span>
        ) : (
          <span className='h-11 w-11 shrink-0' />
        )}

        <div className='min-w-0 flex-1'>
          <div className='flex items-center gap-2'>
            <span className='hidden shrink-0 sm:inline-flex'><LevelChip level={node.level} shade={bg} /></span>
            {hasKids ? (
              <button type='button' onClick={() => onToggle(node.id)} data-testid={'open-' + node.id} className={cx(titleCls, 'flex min-h-11 items-center rounded text-left hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]')}>{node.title}</button>
            ) : (
              isDay || isBlock ? (
                <button type='button' data-testid={'item-' + node.id} onClick={() => onItemClick && onItemClick(node)}
                  className={cx(titleCls, 'rounded text-left hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]')}>{node.title}</button>
              ) : (
                <span className={titleCls}>{node.title}</span>
              )
            )}
            {node.hours ? <span className='shrink-0 font-mono text-[12px] tabular-nums text-[var(--text-muted)]'>{node.hours}h</span> : null}
          </div>
          <div className='mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 sm:hidden'>
            <LevelChip level={node.level} short shade={bg} />
            {when ? <span className='text-[12px] font-mono text-[var(--text-muted)]'>{when}</span> : null}
            {!deep ? <span className='text-[12px] font-mono text-[var(--text-muted)]'>{pct + '%'}</span> : null}
          </div>
        </div>

        {when ? <span className='hidden shrink-0 text-[12px] font-mono text-[var(--text-muted)] sm:block'>{when}</span> : null}
        {!deep ? <div className='hidden w-[130px] md:block'><ProgressBar value={pct} label={node.title} /></div> : null}
      </div>
      {/* Task rows carry the same "I can't do this" / "Break it down with the
          coach" pair as the Today tab — this is where the plan actually gets
          renegotiated, so the affordance belongs on the row, not one tab away.
          Indented past the row's own left border + control column to line up
          under the title. Blocks are scheduled time, not negotiable work, so
          they get nothing (same rule as TodayTimetable). */}
      {isDay && !node.done && onHelp ? (
        <div style={{ paddingLeft: 6 + depth * 12 + 52 }} className='mt-1 pr-2 pb-1'>
          <NeedHelpActions
            item={{ _kind: 'plan', id: node.id, text: node.title }}
            prefix='plan'
            onCant={onHelp.onCant}
            onAddToPlan={onHelp.onAddToPlan}
          />
        </div>
      ) : null}
      {hasKids && isOpen ? (
        <ul data-testid={'children-' + node.id} className='mt-1 space-y-2 sm:mt-0.5 sm:space-y-0.5'>
          {kids.map((c) => <TreeRow key={c.id} node={c} depth={depth + 1} expanded={expanded} onToggle={onToggle} onTask={onTask} palette={palette} onItemClick={onItemClick} onHelp={onHelp} />)}
        </ul>
      ) : null}
    </li>
  );
}

export function PlanLadder({ goal, nodes = [], milestones = [], onToggle, onToggleTask, defaultExpanded, palette, onItemClick, onHelp, pager }) {
  const pal = palette || paletteFor(0);
  const tree = buildTree(nodes);
  const [expanded, setExpanded] = useState(() => {
    if (defaultExpanded) return new Set(defaultExpanded);
    return new Set(nodes.filter((n) => nestDepth(n.level) <= 2).map((n) => n.id));
  });
  const handleToggle = (id) => setExpanded((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  return (
    <section data-testid='plan-ladder' aria-label='Plan hierarchy' className='space-y-3'>
      <header className='sticky top-0 z-10 flex items-center gap-2 rounded-md bg-[var(--bg-primary)] px-1 py-2'>
        <span className='grid h-8 w-8 shrink-0 place-items-center rounded-md' style={{ backgroundColor: pal.shades[1], color: PLAN_INK }}><Target className='h-4 w-4' aria-hidden='true' /></span>
        <div className='min-w-0 flex-1'>
          <h2 className='break-words text-[16px] font-semibold leading-tight text-[var(--text-primary)] sm:truncate'>{goal ? goal.title : 'Goal'}</h2>
          <p className='text-[12px] text-[var(--text-muted)]'>
            {goal && goal.weekly_hours ? goal.weekly_hours + 'h/wk \u00b7 ' : ''}
            {goal && goal.drift_status === 'at_risk' ? 'at risk \u00b7 ' : ''}
            {'target ' + fmt(goal && goal.target_date)}
          </p>
        </div>
        {pager ? (
          <div className='flex shrink-0 items-center gap-1' aria-label='Goal pager'>
            <button type='button' aria-label='Previous goal' data-testid='goal-prev' disabled={pager.index === 0} onClick={pager.onPrev}
              className='flex h-11 w-11 items-center justify-center rounded-full text-[var(--text-primary)] disabled:opacity-40 hover:bg-[var(--bg-secondary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]'>
              <ChevronLeft className='h-4 w-4' aria-hidden='true' />
            </button>
            <span data-testid='goal-position' className='text-[12px] font-mono tabular-nums text-[var(--text-muted)]'>{pager.index + 1} / {pager.total}</span>
            <button type='button' aria-label='Next goal' data-testid='goal-next' disabled={pager.index === pager.total - 1} onClick={pager.onNext}
              className='flex h-11 w-11 items-center justify-center rounded-full text-[var(--text-primary)] disabled:opacity-40 hover:bg-[var(--bg-secondary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]'>
              <ChevronRight className='h-4 w-4' aria-hidden='true' />
            </button>
          </div>
        ) : null}
      </header>

      <MilestoneOverlay milestones={milestones} onItemClick={onItemClick} />

      <ul data-testid='plan-ladder-rows' className='space-y-2 sm:space-y-0.5'>
        {tree.map((n) => <TreeRow key={n.id} node={n} depth={0} expanded={expanded} onToggle={handleToggle} onTask={onToggleTask} onItemClick={onItemClick} palette={pal} onHelp={onHelp} />)}
      </ul>
    </section>
  );
}

/* ------------------------------------------------------------------ Zoom */

const ZOOMS = ['year', 'quarter', 'month', 'week', 'day'];
const GRID = { year: 12, quarter: 13, month: 30, week: 7, day: 1 };

/**
 * @deprecated Unreferenced by production code. This was the plan route's own
 * zoomable grid. It was superseded first by `PlanCalendarNative`, and that has
 * since been deleted as well — Timeline owns the calendar (Day → Year, with
 * nested goal spans) and the plan route renders the ladder alone. Nothing but
 * `PlanHierarchy.stories.jsx` imports `PlanZoom`, so it now survives only on
 * its own stories. Left in place so removing it is a deliberate call rather
 * than a side effect.
 */
export function PlanZoom({ initialZoom = 'month', goals = [], milestones = [] }) {
  const [zoom, setZoom] = useState(initialZoom);
  const cols = GRID[zoom];
  return (
    <section data-testid='plan-zoom' aria-label='Plan timeline' className='space-y-4'>
      <div className='flex flex-wrap items-center gap-2'>
        <div className='inline-flex max-w-full flex-wrap rounded-full border border-[var(--border)] bg-[var(--bg-secondary)] p-0.5' role='tablist' aria-label='Time zoom'>
          {ZOOMS.map((z) => (
            <button key={z} type='button' role='tab' aria-selected={zoom === z} data-testid={'zoom-' + z} onClick={() => setZoom(z)}
              className={cx('min-h-11 rounded-full px-3 text-[12px] font-mono uppercase tracking-wider transition-colors motion-reduce:transition-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]', zoom === z ? 'bg-[var(--accent)] text-[var(--bg-primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]')}>
              {level(z).short}
            </button>
          ))}
        </div>
        <span className='inline-flex items-center gap-1 text-[12px] font-mono uppercase tracking-wider text-[var(--text-muted)]'><Layers className='h-3 w-3' aria-hidden='true' /> {cols + ' cols'}</span>
      </div>
      {milestones.length > 0 ? (
        <div className='flex flex-wrap gap-1.5' data-testid='zoom-milestone-pins'>
          {milestones.map((m) => (
            <span key={m.id} className='inline-flex items-center gap-1 rounded-full border border-[var(--accent)] px-2 py-0.5 text-[12px] text-[var(--text-primary)]'><Flag className='h-3 w-3 text-[var(--accent)]' aria-hidden='true' />{m.title}</span>
          ))}
        </div>
      ) : null}
      {zoom === 'day' ? (
        <ul data-testid='zoom-day-grid' className='divide-y divide-[var(--border)] rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)]'>
          {goals.map((g) => (
            <li key={g.id} className='flex items-center gap-3 px-3 py-2'>
              <span className='w-20 shrink-0 text-[12px] font-mono tabular-nums text-[var(--text-muted)]'>{g.slot || ''}</span>
              <span className='h-5 min-w-0 flex-1 truncate rounded bg-[color-mix(in_srgb,var(--accent)_22%,transparent)] px-2 text-[13px] leading-5 text-[var(--text-primary)]'>{g.title}</span>
            </li>
          ))}
        </ul>
      ) : (
        <ul data-testid='zoom-bands' className='space-y-2'>
          {goals.map((g) => {
            const left = Math.round((g.start || 0) * 100);
            const width = Math.max(4, Math.round(((g.end || 1) - (g.start || 0)) * 100));
            return (
              <li key={g.id} className='flex items-center gap-2 sm:gap-3'>
                <span className='w-24 shrink-0 truncate text-[13px] text-[var(--text-primary)] sm:w-36'>{g.title}</span>
                <span className='relative h-5 min-w-0 flex-1 overflow-hidden rounded bg-[var(--bg-primary)]'>
                  <span className='absolute inset-y-0 rounded' style={{ left: left + '%', width: width + '%', background: g.drift_status === 'at_risk' ? 'color-mix(in srgb, var(--accent) 55%, var(--danger))' : 'var(--accent)' }} />
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
