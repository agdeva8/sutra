import { useEffect, useMemo, useRef, useState } from 'react';
import FullCalendar from '@fullcalendar/react';
import multiMonthPlugin from '@fullcalendar/multimonth';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import { Flag, Target, Clock, CalendarDays } from 'lucide-react';
import { paletteFor, PLAN_INK } from './planColors';

/**
 * PlanCalendar - FullCalendar 6, coloured per goal.
 *
 * - View is chosen from a DROPDOWN at the TOP (not toolbar buttons).
 * - Year shows only the coarse plan: goals + milestones + blockers +
 *   commitments. Week/Day add the other time blocks.
 * - Each goal has a hue; its goal bar is the lightest shade, milestones a
 *   mid shade, its commitments the darkest - all light enough for dark ink.
 */

function addDay(iso) {
  const d = new Date(String(iso).slice(0, 10) + 'T00:00:00.000Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const VIEWS = [
  { id: 'multiMonthYear', label: 'Year' },
  { id: 'dayGridMonth', label: 'Month' },
  { id: 'timeGridWeek', label: 'Week' },
  { id: 'timeGridDay', label: 'Day' },
];
// Only the year view is coarse: the month shows each planned session on its day (`dayMaxEvents` folds a
// crowded day into "+n more"), so the plan is visible day by day without zooming to a week.
const COARSE = { multiMonthYear: true };

export function buildEvents({ goals = [], milestones = [], blockers = [], blocks = [] }, paletteByGoalId) {
  const pal = (id) => (paletteByGoalId && paletteByGoalId.get(id)) || paletteFor(0);
  const out = [];
  for (const g of goals) {
    const p = pal(g.id);
    out.push({ id: 'g-' + g.id, title: g.title, start: g.start_date, end: g.target_date ? addDay(g.target_date) : undefined, allDay: true,
      backgroundColor: p.shades[0], borderColor: p.strong, textColor: PLAN_INK, extendedProps: { type: 'goal' } });
  }
  for (const m of milestones) {
    const p = pal(m.goal_id);
    out.push({ id: 'm-' + m.id, title: m.title, start: m.target_date, allDay: true,
      backgroundColor: p.shades[2], borderColor: p.strong, textColor: PLAN_INK, extendedProps: { type: 'milestone', done: m.status === 'done' } });
  }
  for (const b of blockers) {
    out.push({ id: 'b-' + b.id, start: b.start_date, end: b.end_date ? addDay(b.end_date) : addDay(b.start_date), display: 'background',
      backgroundColor: 'color-mix(in srgb, #DC2626 24%, transparent)', extendedProps: { type: 'blocker' } });
  }
  for (const bl of blocks) {
    const p = pal(bl.goal_id);
    out.push({ id: 'bl-' + bl.id, title: bl.label, start: bl.block_date + 'T' + (bl.start_time || '09:00'), end: bl.block_date + 'T' + (bl.end_time || '10:00'),
      backgroundColor: p.shades[4], borderColor: p.strong, textColor: PLAN_INK, extendedProps: { type: 'block', kind: bl.kind } });
  }
  return out;
}

const FC_VARS = {
  '--fc-border-color': 'var(--border)', '--fc-page-bg-color': 'transparent', '--fc-neutral-bg-color': 'var(--bg-secondary)',
  '--fc-neutral-text-color': 'var(--text-secondary)', '--fc-today-bg-color': 'color-mix(in srgb, var(--accent) 9%, transparent)',
  '--fc-list-event-hover-bg-color': 'var(--bg-secondary)', '--fc-button-bg-color': 'var(--bg-secondary)',
  '--fc-button-border-color': 'var(--border)', '--fc-button-text-color': 'var(--text-primary)', '--fc-button-hover-bg-color': 'var(--bg-primary)',
  '--fc-button-hover-border-color': 'var(--border-accent)', '--fc-button-active-bg-color': 'var(--accent)', '--fc-button-active-border-color': 'var(--accent)',
};

function renderContent(arg) {
  const p = arg.event.extendedProps || {};
  if (p.type === 'milestone') return <span className='flex min-w-0 items-center gap-1' title={arg.event.title}><Flag className='h-3 w-3 shrink-0' aria-hidden='true' /><span className={p.done ? 'truncate line-through opacity-60' : 'truncate'}>{arg.event.title}</span></span>;
  if (p.type === 'block') return <span className='flex min-w-0 items-center gap-1' title={arg.event.title}><Clock className='h-3 w-3 shrink-0' aria-hidden='true' /><span className='truncate'>{arg.event.timeText + ' ' + arg.event.title}</span></span>;
  if (p.type === 'goal') return <span className='flex min-w-0 items-center gap-1' title={arg.event.title}><Target className='h-3 w-3 shrink-0' aria-hidden='true' /><span className='truncate'>{arg.event.title}</span></span>;
  return <span className='truncate'>{arg.event.title}</span>;
}

export function PlanCalendar({ goals = [], milestones = [], blockers = [], blocks = [], initialView = 'dayGridMonth', onEventClick, height = 'auto' }) {
  const calRef = useRef(null);
  const [view, setView] = useState(initialView);
  const paletteByGoalId = useMemo(() => { const m = new Map(); goals.forEach((g, i) => m.set(g.id, paletteFor(i))); return m; }, [goals]);
  const coarse = !!COARSE[view];
  const events = useMemo(() => {
    const visibleBlocks = coarse ? blocks.filter((b) => (b.kind || '') === 'commitment') : blocks;
    return buildEvents({ goals, milestones, blockers, blocks: visibleBlocks }, paletteByGoalId);
  }, [goals, milestones, blockers, blocks, coarse, paletteByGoalId]);

  const changeView = (v) => { const api = calRef.current && calRef.current.getApi && calRef.current.getApi(); if (api) api.changeView(v); setView(v); };

  return (
    <div data-testid='plan-calendar' style={FC_VARS}
      className='max-w-full overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-2 text-[var(--text-primary)] sm:p-3 [&_.fc]:max-w-full [&_.fc-toolbar]:mb-2 [&_.fc-toolbar]:flex-wrap [&_.fc-toolbar]:gap-2 [&_.fc-toolbar-chunk]:flex [&_.fc-toolbar-chunk]:items-center [&_.fc-toolbar-title]:text-[14px] [&_.fc-toolbar-title]:font-semibold [&_.fc-button]:px-2.5 [&_.fc-button]:py-1 [&_.fc-button]:text-[12px] [&_.fc-button]:uppercase [&_.fc-button]:tracking-wider [&_.fc-event]:overflow-hidden [&_.fc-event-main]:overflow-hidden [&_.fc-event-main-frame]:min-w-0 [&_.fc-event-title]:truncate [&_.fc-h-event]:overflow-hidden'>
      <div className='mb-2 flex items-center gap-2'>
        <label htmlFor='cal-view' className='inline-flex items-center gap-1.5 text-[12px] font-mono uppercase tracking-wider text-[var(--text-muted)]'><CalendarDays className='h-3.5 w-3.5' aria-hidden='true' /> View</label>
        <select id='cal-view' data-testid='cal-view-select' value={view} onChange={(e) => changeView(e.target.value)}
          className='min-h-11 flex-1 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 text-[12px] text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] sm:flex-none'>
          {VIEWS.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
        </select>
      </div>
      <FullCalendar ref={calRef}
        plugins={[multiMonthPlugin, dayGridPlugin, timeGridPlugin, interactionPlugin]}
        initialView={initialView}
        headerToolbar={{ left: 'prev,next today', center: 'title', right: '' }}
        buttonText={{ today: 'Today' }}
        firstDay={1} height={height} dayMaxEvents nowIndicator events={events}
        eventContent={renderContent}
        viewDidMount={(a) => setView(a.view.type)}
        eventClick={(info) => onEventClick && onEventClick(info.event)} />
    </div>
  );
}
