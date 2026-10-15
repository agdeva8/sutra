import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import CalendarMonthGrid from './CalendarMonthGrid';
import { HourGrid } from './CalendarHourGrid';
import { paletteFor, PLAN_INK } from './planColors';
import { KIND_STYLE, GOAL_GLYPH } from '../constants/calendarKinds';

function useMinWidth(px) {
  const [match, setMatch] = useState(() => (typeof window === 'undefined' || !window.matchMedia) ? true : window.matchMedia('(min-width: ' + px + 'px)').matches);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const mq = window.matchMedia('(min-width: ' + px + 'px)');
    const on = () => setMatch(mq.matches);
    if (mq.addEventListener) mq.addEventListener('change', on); else mq.addListener(on);
    return () => { if (mq.removeEventListener) mq.removeEventListener('change', on); else mq.removeListener(on); };
  }, [px]);
  return match;
}
const iso = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function addDays(d, n) { const x = startOfDay(d); x.setDate(x.getDate() + n); return x; }
function addMonths(d, n) { const x = startOfDay(d); x.setDate(1); x.setMonth(x.getMonth() + n); return x; }
function weekStart(d) { const x = startOfDay(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }

export function toNativeCards({ goals = [], milestones = [], blockers = [], blocks = [] }) {
  const paletteByGoal = new Map();
  goals.forEach((g, i) => paletteByGoal.set(g.id, paletteFor(i)));
  const pal = (id) => paletteByGoal.get(id) || paletteFor(0);
  const goalTitleOf = (id) => { const g = goals.find((x) => x.id === id); return g ? g.title : ''; };
  const cards = [];
  const push = (id, kind, title, startIso, endIso, color, extra = {}) => {
    const start = startIso ? new Date(String(startIso).slice(0, 10) + 'T00:00:00') : null;
    if (!start || Number.isNaN(start.getTime())) return;
    const end = endIso && endIso !== startIso ? new Date(String(endIso).slice(0, 10) + 'T00:00:00') : start;
    const glyph = kind === 'milestone' ? KIND_STYLE.milestone.glyph : kind === 'blocker' ? KIND_STYLE.blocker.glyph : kind === 'goal' ? GOAL_GLYPH : KIND_STYLE.session.glyph;
    cards.push({ id, item: { id, kind, title, start, end }, date: start, glyph, title, color, ...extra });
  };
  for (const g of goals) push('g-' + g.id, 'goal', g.title, g.start_date, g.target_date, pal(g.id).strong);
  for (const m of milestones) push('m-' + m.id, 'milestone', m.title, m.target_date, null, pal(m.goal_id).strong, { goalTitle: goalTitleOf(m.goal_id), status: m.status === 'done' ? 'done' : undefined });
  for (const b of blockers) push('b-' + b.id, 'blocker', b.title, b.start_date, b.end_date || b.start_date, 'var(--danger)');
  for (const bl of blocks) push('bl-' + bl.id, 'task', bl.label, bl.block_date, null, pal(bl.goal_id).strong, { goalTitle: goalTitleOf(bl.goal_id), hours: (bl.start_time || '') + '\u2013' + (bl.end_time || '') });
  return cards;
}

function MiniMonth({ start, cards, covered = false, onDay, todayIso }) {
  const isoOfDay = (y, m, d2) => y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d2).padStart(2, '0');
  const year = start.getFullYear();
  const month = start.getMonth();
  const offset = (new Date(year, month, 1).getDay() + 6) % 7;
  const daysIn = new Date(year, month + 1, 0).getDate();
  const byDate = new Map();
  for (const c of cards) {
    if (!c.date || c.date.getFullYear() !== year || c.date.getMonth() !== month) continue;
    const list = byDate.get(c.date.getDate()) || [];
    list.push(c); byDate.set(c.date.getDate(), list);
  }
  const cells = [];
  for (let i = 0; i < offset; i += 1) cells.push(null);
  for (let d = 1; d <= daysIn; d += 1) cells.push(d);
  while (cells.length % 7) cells.push(null);
  return (
    <div className='rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] p-1.5'>
      <div className='mb-0.5 text-center text-[9px] font-mono uppercase tracking-wider text-[var(--text-muted)]'>{new Date(year, month, 1).toLocaleString('en-US', { month: 'short' })}</div>
      {covered ? <span className='mx-auto mb-0.5 block h-1 w-5 rounded-full' style={{ backgroundColor: 'var(--accent)' }} aria-hidden='true' /> : null}
      <div className='grid grid-cols-7 gap-px'>
        {cells.map((d, i) => (
          <div key={i} className='flex justify-center'>
            {d != null ? (
              <button type='button' data-testid={'ncal-ym-' + month + '-d' + d} onClick={() => onDay && onDay(new Date(year, month, d))}
                className={'relative flex h-5 w-5 items-center justify-center rounded text-[9px] tabular-nums hover:bg-[var(--bg-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)] ' + (todayIso === isoOfDay(year, month, d) ? 'bg-[color-mix(in_srgb,var(--accent)_20%,transparent)] font-semibold text-[var(--text-primary)]' : 'text-[var(--text-muted)]')}>
                {d}
                {byDate.has(d) ? (
                  <span className='pointer-events-none absolute -bottom-0.5 flex gap-0.5 text-[8px] leading-none'>
                    {byDate.get(d).slice(0, 3).map((c, j) => <span key={j} style={{ color: c.color }}>{c.glyph}</span>)}
                  </span>
                ) : null}
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function YearView({ yearStart, cards, goals = [], onDay }) {
  const nowD = new Date();
  const todayIso = nowD.getFullYear() + '-' + String(nowD.getMonth() + 1).padStart(2, '0') + '-' + String(nowD.getDate()).padStart(2, '0');
  const goalMonths = new Set();
  (goals || []).forEach((g) => {
    const sStr = String(g.start_date || ''); const tStr = String(g.target_date || '');
    if (sStr.length < 7) return;
    const s = Number(sStr.slice(0, 4)) * 12 + (Number(sStr.slice(5, 7)) - 1);
    const t = tStr.length >= 7 ? Number(tStr.slice(0, 4)) * 12 + (Number(tStr.slice(5, 7)) - 1) : s + 120;
    for (let k = s; k <= t; k += 1) goalMonths.add(k);
  });
  const months = Array.from({ length: 12 }, (_, m) => new Date(yearStart.getFullYear(), m, 1));
  return (
    <div className='grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-4'>
      {months.map((m) => <MiniMonth key={m.getMonth()} start={m} cards={cards} covered={goalMonths.has(m.getFullYear() * 12 + m.getMonth())} onDay={onDay} todayIso={todayIso} />)}
    </div>
  );
}

function DecadeView({ decadeStart, goals = [], onSelectYear }) {
  const y0 = decadeStart.getFullYear();
  const years = Array.from({ length: 10 }, (_, i) => y0 + i);
  const active = (y) => goals.filter((g) => {
    const s = g.start_date ? Number(String(g.start_date).slice(0, 4)) : Infinity;
    const t = g.target_date ? Number(String(g.target_date).slice(0, 4)) : -Infinity;
    return s <= y && y <= t;
  });
  const nowYear = new Date().getFullYear();
  return (
    <div className='grid grid-cols-2 gap-2 sm:grid-cols-5' data-testid='ncal-decade-grid'>
      {years.map((y) => {
        const gs = active(y);
        return (
          <button key={y} type='button' data-testid={'ncal-decade-' + y} onClick={() => onSelectYear(y)}
            className={'rounded-md border p-1.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] ' + (y === nowYear ? 'border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_10%,var(--bg-secondary))]' : 'border-[var(--border)] bg-[var(--bg-secondary)] hover:border-[var(--border-accent)]')}>
            <span className='block text-[13px] font-semibold text-[var(--text-primary)]'>{y}</span>
            <span className='mt-1 block space-y-0.5'>
              {gs.length ? gs.slice(0, 3).map((g, i) => (
                <span key={g.id} className='block truncate rounded px-1 py-0.5 text-[9px]' style={{ backgroundColor: paletteFor(i).shades[0], color: PLAN_INK }}>{g.title}</span>
              )) : <span className='block text-[9px] text-[var(--text-muted)]'>No plan</span>}
              {gs.length > 3 ? <span className='block text-[9px] text-[var(--text-muted)]'>+{gs.length - 3} more</span> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function WeekSpanRow({ days, blockers }) {
  const cols = days.length;
  const ds = days.map(iso);
  const overlap = (blockers || []).filter((b) => {
    const b0 = b.start_date ? String(b.start_date).slice(0, 10) : '';
    const b1 = b.end_date ? String(b.end_date).slice(0, 10) : b0;
    return b0 && ds[0] <= b1 && ds[cols - 1] >= b0;
  });
  if (!overlap.length) return null;
  return (
    <div className='relative mb-1 h-7' style={{ display: 'grid', gridTemplateColumns: 'repeat(' + cols + ', minmax(0, 1fr))' }}>
      {days.map((d) => <div key={iso(d)} className='border-l border-[var(--border)]' />)}
      {overlap.map((b) => {
        const b0 = String(b.start_date || '').slice(0, 10);
        const b1 = String(b.end_date || b.start_date || '').slice(0, 10);
        let s = ds.findIndex((x) => x >= b0); if (s < 0) s = 0;
        let e = ds.findIndex((x) => x > b1); if (e < 0) e = cols; else e -= 1; if (e > cols - 1) e = cols - 1; if (e < s) e = s;
        return (
          <div key={b.id} data-testid={'week-blocker-' + b.id} className='z-10 truncate rounded-[3px] px-1.5 py-0.5 text-[10px] text-[var(--text-primary)]'
            style={{ gridColumn: (s + 1) + ' / span ' + (e - s + 1), backgroundColor: 'color-mix(in srgb, var(--danger) 16%, var(--bg-primary))', borderLeft: '3px solid var(--danger)' }}>
            {b.title}
          </div>
        );
      })}
    </div>
  );
}
const VIEWS = [
  { id: 'day', label: 'Day' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'year', label: 'Year' },
  { id: 'decade', label: 'Decade' },
];

export function PlanCalendarNative({ goals = [], milestones = [], blockers = [], blocks = [], onSelectItem, onSelectDay }) {
  const isDesktop = useMinWidth(640);
  const [view, setView] = useState('month');
  const [anchor, setAnchor] = useState(() => weekStart(new Date()));
  const cards = toNativeCards({ goals, milestones, blockers, blocks });

  const byId = new Map();
  milestones.forEach((x) => byId.set('m-' + x.id, { kind: 'milestone', ...x }));
  goals.forEach((x) => byId.set('g-' + x.id, { kind: 'goal', ...x }));
  blockers.forEach((x) => byId.set('b-' + x.id, { kind: 'blocker', ...x }));
  blocks.forEach((x) => byId.set('bl-' + x.id, { kind: 'block', ...x }));
  const handleItem = (item) => { const row = byId.get(item && item.id); onSelectItem && onSelectItem(row || item); };
  const palOf = (id) => { const i = goals.findIndex((g) => g.id === id); return paletteFor(i >= 0 ? i : 0); };
  const styled = (b) => ({ ...b, color: palOf(b.goal_id).shades[4], borderColor: palOf(b.goal_id).strong });

  const step = () => setAnchor((a) => (
    view === 'day' ? addDays(a, 1) :
    view === 'week' ? addDays(a, 7) :
    view === 'month' ? addMonths(a, 1) :
    view === 'year' ? new Date(a.getFullYear() + 1, 0, 1) :
    new Date(a.getFullYear() + 10, 0, 1)
  ));
  const back = () => setAnchor((a) => (
    view === 'day' ? addDays(a, -1) :
    view === 'week' ? addDays(a, -7) :
    view === 'month' ? addMonths(a, -1) :
    view === 'year' ? new Date(a.getFullYear() - 1, 0, 1) :
    new Date(a.getFullYear() - 10, 0, 1)
  ));
  const today = () => setAnchor(view === 'week' ? weekStart(new Date()) : new Date());

  const days = view === 'week' ? Array.from({ length: 7 }, (_, i) => addDays(weekStart(anchor), i)) : view === 'day' ? [startOfDay(anchor)] : null;
  const inRange = days ? new Set(days.map(iso)) : null;
  const visibleBlocks = (days ? blocks.filter((b) => b.block_date && inRange.has(String(b.block_date).slice(0, 10))) : blocks).map(styled);
  const visibleCards = days ? cards.filter((c) => c.date && inRange.has(iso(c.date))) : cards;

  const rangeLabel =
    view === 'day' ? startOfDay(anchor).toDateString().slice(4) :
    view === 'week' ? 'Week of ' + weekStart(anchor).toDateString().slice(4) :
    view === 'month' ? new Date(anchor).toLocaleString('en-US', { month: 'long', year: 'numeric' }) :
    view === 'year' ? String(anchor.getFullYear()) :
    anchor.getFullYear() + ' \u2013 ' + (anchor.getFullYear() + 9);

  return (
    <div data-testid='plan-calendar-native' className='rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] p-2 sm:p-3'>
      <div className='mb-2 flex flex-wrap items-center justify-between gap-2'>
        {isDesktop ? (
          <div className='inline-flex max-w-full flex-wrap rounded-full border border-[var(--border)] bg-[var(--bg-secondary)] p-0.5' role='tablist' aria-label='Calendar view'>
            {VIEWS.map((v) => (
              <button key={v.id} type='button' role='tab' aria-selected={view === v.id} data-testid={'ncal-view-' + v.id} onClick={() => setView(v.id)}
                className={'min-h-9 rounded-full px-2.5 text-[12px] font-mono uppercase tracking-wider transition-colors motion-reduce:transition-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] ' + (view === v.id ? 'bg-[var(--accent)] text-[var(--bg-primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]')}>
                {v.label}
              </button>
            ))}
          </div>
        ) : (
          <select data-testid='ncal-view-select' aria-label='View' value={view} onChange={(e) => setView(e.target.value)}
            className='h-9 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 text-[13px] text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]'>
            {VIEWS.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
          </select>
        )}
        <div className='flex items-center gap-0.5'>
          <button type='button' aria-label='Previous' data-testid='ncal-prev' onClick={back}
            className='flex h-9 w-9 items-center justify-center rounded-full text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]'><ChevronLeft className='h-4 w-4' aria-hidden='true' /></button>
          <span className='min-w-[64px] text-center text-[11px] font-mono tabular-nums text-[var(--text-muted)]'>{rangeLabel}</span>
          <button type='button' data-testid='ncal-today' onClick={today}
            className='h-9 rounded-full border border-[var(--border)] px-2.5 text-[12px] text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]'>Today</button>
          <button type='button' aria-label='Next' data-testid='ncal-next' onClick={step}
            className='flex h-9 w-9 items-center justify-center rounded-full text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]'><ChevronRight className='h-4 w-4' aria-hidden='true' /></button>
        </div>
      </div>

      {view === 'month' ? (
        <CalendarMonthGrid anchor={anchor} cards={cards} today={new Date()} onSelectItem={handleItem} onSelectDay={onSelectDay || (() => {})} />
      ) : view === 'week' || view === 'day' ? (
        <div className='space-y-1'>
          {view === 'week' ? <WeekSpanRow days={days} blockers={blockers} /> : null}
          <HourGrid days={days} blocks={visibleBlocks} cards={visibleCards} today={new Date()} onSelectItem={handleItem} onSelectSlot={(d) => onSelectDay && onSelectDay(d)} />
        </div>
      ) : view === 'year' ? (
        <YearView yearStart={anchor} cards={cards} goals={goals} onDay={onSelectDay || (() => {})} />
      ) : (
        <DecadeView decadeStart={anchor} goals={goals} onSelectYear={(y) => { setAnchor(new Date(y, 0, 1)); setView('year'); }} />
      )}
    </div>
  );
}
