import { useMemo, useState } from 'react';
import { LayoutDashboard, Target, Image as ImageIcon, FileText, Sparkles, CalendarRange, ListTree, Info } from 'lucide-react';
import { PlanLadder } from './PlanHierarchy';
import { PlanCalendarNative } from './PlanCalendarNative';
import AddToDayDialog from './AddToDayDialog';
import { DaySheet } from './DaySheet';
import { TimelineItemDetailsDialog } from './Timeline';
import { paletteFor } from './planColors';

/**
 * PlanWorkspace - replaces Goals / Today / Timeline.
 *
 * Interactive mock:
 *  - Calendar (native grid): click a CELL -> AddToDayDialog (create a task,
 *    time block / commitment, or blocker); click an ITEM (goal bar,
 *    milestone pin, blocker, task) -> details dialog.
 *  - Plan tree: click a week's disclosure to drill; click a Task/Block row
 *    or a milestone chip -> details dialog.
 */

export const SCREENS = [
  { key: 'home', label: 'Overview', Icon: LayoutDashboard },
  { key: 'plan', label: 'Plan', Icon: Target },
  { key: 'memories', label: 'Memories', Icon: ImageIcon },
  { key: 'sources', label: 'Sources', Icon: FileText },
  { key: 'motivation', label: 'Curated', Icon: Sparkles },
];

const VIEWS = [
  { key: 'tree', label: 'Plan tree', Icon: ListTree },
  { key: 'calendar', label: 'Calendar', Icon: CalendarRange },
];

function NavStrip({ active = 'plan' }) {
  return (
    <nav aria-label='Primary' className='flex flex-wrap items-center gap-1 border-b border-[var(--border)] pb-px'>
      {SCREENS.map((s) => {
        const isActive = s.key === active;
        return (
          <button key={s.key} type='button' aria-current={isActive ? 'page' : undefined}
            className={'inline-flex min-h-11 items-center gap-1.5 border-b-2 px-3 text-[12px] font-medium transition-colors motion-reduce:transition-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] ' + (isActive ? 'border-[var(--accent)] text-[var(--accent)]' : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]')}>
            <s.Icon className='h-3.5 w-3.5' aria-hidden='true' /> {s.label}
          </button>
        );
      })}
    </nav>
  );
}

function nodeToItem(node, goalId) {
  return {
    kind: node.level === 'block' ? 'block' : 'task',
    id: node.id, title: node.title,
    note: node.note || (node.hours ? node.hours + 'h' : ''),
    date: node.start_date || null, target_date: node.start_date || null,
    goal_id: goalId, status: node.done ? 'done' : 'open', hours: node.hours,
  };
}

function rowToDetails(row) {
  return {
    kind: row.kind || 'task', id: row.id, title: row.title,
    date: row.start_date || row.target_date || row.block_date || null,
    target_date: row.target_date || row.block_date || null,
    goal_id: row.goal_id, status: row.status || 'open',
    note: row.rationale || '', hours: row.hours || (row.start_time ? row.start_time + '\u2013' + row.end_time : ''),
  };
}

function collectDay(date, plansArg, goals, milestones, blockers, blocks) {
  const key = date instanceof Date ? date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0') : String(date).slice(0, 10);
  const nodeItem = (n, goalId) => ({ kind: n.level === 'block' ? 'block' : n.level === 'day' ? 'task' : n.level, id: n.id, title: n.title, date: n.start_date || key, target_date: n.due_date || n.end_date || null, goal_id: goalId, status: n.done ? 'done' : 'open', hours: n.hours, note: n.note || '' });
  const dayTree = (plansArg || []).map((p, pi) => {
    const rows = [];
    let wk = null;
    const pc = paletteFor(pi);
    (p.nodes || []).forEach((n) => {
      if (n.level === 'week' && n.start_date) wk = String(n.start_date).slice(0, 10);
      if (n.level === 'year' || n.level === 'quarter' || n.level === 'month' || n.level === 'week') {
        const s = n.start_date ? String(n.start_date).slice(0, 10) : null;
        const e = n.end_date ? String(n.end_date).slice(0, 10) : null;
        if (s && key >= s && (!e || key <= e)) rows.push({ level: n.level, title: n.title, meta: s + (e && e !== s ? ' \u2013 ' + e : ''), item: nodeItem(n, p.goal && p.goal.id) });
      } else if (n.level === 'day') {
        const d = n.start_date ? String(n.start_date).slice(0, 10) : wk;
        if (d === key) rows.push({ level: 'day', title: n.title, meta: n.hours ? n.hours + 'h' : '', item: nodeItem(n, p.goal && p.goal.id) });
      }
    });
    (milestones || []).filter((m) => (m.target_date || '').slice(0, 10) === key && m.goal_id === (p.goal && p.goal.id)).forEach((m) => rows.push({ level: 'milestone', title: m.title, meta: String(m.target_date || '').slice(0, 10), item: m }));
    if (p.goal && p.goal.target_date && String(p.goal.target_date).slice(0, 10) === key) rows.push({ level: 'goal-end', title: 'Goal ends today', meta: String(p.goal.target_date).slice(0, 10), item: { kind: 'goal', id: p.goal.id, title: p.goal.title, target_date: p.goal.target_date } });
    return { goal: p.goal, palette: pc, rows };
  }).filter((x) => x.rows.length > 0);
  const palOf = (id) => { const i = goals.findIndex((g) => g.id === id); return paletteFor(i >= 0 ? i : 0); };
  const timeBlocks = (blocks || []).filter((b) => b.block_date && String(b.block_date).slice(0, 10) === key).map((b) => ({ ...b, kind: 'block', title: b.label, color: palOf(b.goal_id).shades[4] }));
  const dayBlockers = (blockers || []).filter((b) => (b.start_date || '') <= key && key <= (b.end_date || b.start_date || key)).map((b) => ({ ...b, kind: 'blocker' }));
  const goalsOnDay = (goals || []).filter((g) => (g.start_date || '') <= key && key <= (g.target_date || g.start_date || key)).map((g, i) => ({ id: g.id, title: g.title, color: paletteFor(i).shades[0] }));
  const goalsEndingToday = (goals || []).filter((g) => (g.target_date || '').slice(0, 10) === key).map((g) => g.id);
  return { dayTree, goalsOnDay, goalsEndingToday, timeBlocks, dayBlockers };
}
export function PlanWorkspace(props) {
  const { plans, goals = [], milestones = [], blockers = [], blocks = [], goal, nodes } = props;
  const list = plans && plans.length ? plans : (goal ? [{ id: 'p0', goal, nodes: nodes || [], milestones: milestones || [] }] : []);
  const [view, setView] = useState('tree');
  const [idx, setIdx] = useState(0);
  const safeIdx = Math.max(0, Math.min(idx, list.length - 1));
  const current = list[safeIdx];
  const [addDate, setAddDate] = useState(null);
  const [details, setDetails] = useState(null);
  const [dayView, setDayView] = useState(null);
  const dialogState = { goals, milestones };
  const dayItems = useMemo(() => (dayView ? collectDay(dayView, list, goals, milestones, blockers, blocks) : null), [dayView, list, goals, milestones, blockers, blocks]);

  return (
    <div data-testid='plan-workspace' className='space-y-4'>
      <NavStrip active='plan' />

      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div className='inline-flex rounded-full border border-[var(--border)] bg-[var(--bg-secondary)] p-0.5' role='tablist' aria-label='Plan view'>
          {VIEWS.map((v) => (
            <button key={v.key} type='button' role='tab' aria-selected={view === v.key} data-testid={'plan-view-' + v.key} onClick={() => setView(v.key)}
              className={'inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-[12px] font-mono uppercase tracking-wider transition-colors motion-reduce:transition-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] ' + (view === v.key ? 'bg-[var(--accent)] text-[var(--bg-primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]')}>
              <v.Icon className='h-3.5 w-3.5' aria-hidden='true' /> {v.label}
            </button>
          ))}
        </div>


      </div>

      {view === 'tree' ? (
        current ? (
          <div className='relative'>
            <button type='button' aria-label='More about this goal' data-testid='goal-info' onClick={() => current.goal && setDetails({ kind: 'goal', id: current.goal.id, title: current.goal.title, target_date: current.goal.target_date, goal_id: current.goal.id })}
              className='absolute -top-1 right-0 flex h-11 w-11 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]'>
              <Info className='h-4 w-4' aria-hidden='true' />
            </button>
            <PlanLadder goal={current.goal} nodes={current.nodes} milestones={current.milestones} palette={paletteFor(safeIdx)}
              pager={list.length > 1 ? { index: safeIdx, total: list.length, onPrev: () => setIdx(Math.max(0, safeIdx - 1)), onNext: () => setIdx(Math.min(list.length - 1, safeIdx + 1)) } : undefined}
              onItemClick={(node) => setDetails(nodeToItem(node, current.goal && current.goal.id))} />
          </div>
        ) : null
      ) : (
        <PlanCalendarNative goals={goals} milestones={milestones} blockers={blockers} blocks={blocks}
          onSelectDay={(d) => setDayView(d)}
          onSelectItem={(row) => setDetails(rowToDetails(row))} />
      )}

      {dayView && dayItems ? (
        <DaySheet date={dayView} {...dayItems} goals={dayItems ? dayItems.goalsOnDay : []} onClose={() => setDayView(null)} onSelectGoal={(g) => setDetails({ kind: 'goal', id: g.id, title: g.title, target_date: g.target_date || null, goal_id: g.id })}
        onEditItem={(it) => setDetails({ kind: it.kind || 'task', id: it.id, title: it.title || it.label || '', date: it.block_date || it.start_date || it.date || null, target_date: it.target_date || it.block_date || null, goal_id: it.goal_id, status: it.status || (it.done ? 'done' : 'open'), hours: it.hours || (it.start_time ? it.start_time + '\u2013' + it.end_time : '') })}
          onAdd={() => { const d = dayView; setDayView(null); setAddDate(d); }} />
      ) : null}
      {addDate ? (
        <AddToDayDialog open onClose={() => setAddDate(null)} date={addDate} state={dialogState} onCreated={() => setAddDate(null)} defaultKind='task' />
      ) : null}
      {details ? (
        <TimelineItemDetailsDialog item={details} state={dialogState} onClose={() => setDetails(null)} onEdit={() => setDetails(null)} onRemove={() => setDetails(null)} onToggle={() => setDetails(null)} />
      ) : null}
    </div>
  );
}

export default PlanWorkspace;
