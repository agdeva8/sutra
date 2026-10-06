import { useState } from 'react';
import { X, Plus, Clock, Ban, Pencil, Flag, Target } from 'lucide-react';

const LEVEL_META = { year: 'Year Plan', quarter: 'Quarterly Plan', month: 'Monthly Plan', week: 'Weekly Plan', day: 'Daily Task', milestone: 'Milestone', 'goal-end': 'Goal' };
const LEVEL_GLYPH = { year: '\u25c9', quarter: '\u25ce', month: '\u25cb', week: '\u25bd', day: '\u25cc', milestone: '\u25c6', 'goal-end': '\u2605' };

export function DaySheet({ date, dayTree = [], timeBlocks = [], dayBlockers = [], onAdd, onClose, onEditItem }) {
  const [done, setDone] = useState(() => new Set());
  const toggle = (id) => setDone((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const d = date ? new Date(date) : new Date();
  const h4 = 'mb-1 text-[11px] font-mono uppercase tracking-wider text-[var(--text-muted)]';
  const row = 'flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[12px] hover:bg-[var(--bg-secondary)]';
  const emptyState = !dayTree.length && !timeBlocks.length && !dayBlockers.length;

  const lineBtn = (r) => (
    <button type='button' data-testid={'day-line-' + r.level} onClick={() => onEditItem && onEditItem(r.item)}
      className={row + (r.level === 'day' && done.has(r.item && r.item.id) ? ' text-[var(--text-muted)] line-through' : ' text-[var(--text-primary)]')}>
      <span className='shrink-0 text-[11px] text-[#1F2937]' aria-hidden='true'>
        {r.level === 'day' && done.has(r.item && r.item.id) ? '\u2714' : LEVEL_GLYPH[r.level] || '\u2022'}
      </span>
      <span className='shrink-0 rounded-full border border-[var(--border)] px-1.5 py-px font-mono text-[9px] uppercase tracking-wide text-[var(--text-muted)]'>{LEVEL_META[r.level] || r.level}</span>
      <span className='min-w-0 flex-1 truncate'>{r.title}</span>
      {r.meta ? <span className='shrink-0 font-mono text-[10px] text-[var(--text-muted)]'>{r.meta}</span> : null}
    </button>
  );

  return (
    <div role='dialog' aria-modal='true' data-testid='day-sheet' onClick={onClose}
      className='fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center'>
      <div onClick={(e) => e.stopPropagation()}
        className='flex max-h-[85vh] w-full max-w-md flex-col overflow-auto rounded-t-2xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4 sm:rounded-2xl'>
        <header className='mb-3 flex items-center justify-between gap-2'>
          <h3 className='text-[16px] font-semibold text-[var(--text-primary)]'>{d.toDateString()}</h3>
          <button type='button' aria-label='Close' data-testid='day-close' onClick={onClose}
            className='flex h-11 w-11 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--bg-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]'>
            <X className='h-4 w-4' aria-hidden='true' />
          </button>
        </header>

        {dayTree.length ? (
          <section className='mb-3'>
            <h4 className={h4}>On this day</h4>
            <div className='space-y-2'>
              {dayTree.map((g, gi) => (
                <div key={gi} className='rounded-md border border-[var(--border)] bg-[var(--bg-primary)] p-2' style={{ boxShadow: 'inset 3px 0 0 0 ' + g.palette.strong }}>
                  <div className='mb-1 flex items-center gap-1 text-[13px] font-semibold text-[#1F2937]'>
                    <Target className='h-3 w-3' aria-hidden='true' />
                    <span className='truncate'>{g.goal ? g.goal.title : 'General'}</span>
                  </div>
                  <ul className='space-y-0.5'>
                    {g.rows.map((r, ri) => <li key={ri}>{lineBtn(r)}</li>)}
                  </ul>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        
        {timeBlocks.length ? (
          <section className='mb-3'>
            <h4 className={h4}>Commitments &amp; blocks</h4>
            <ul className='space-y-1'>
              {timeBlocks.map((b) => (
                <li key={b.id} className='flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1.5' style={{ borderLeft: '3px solid ' + b.color }}>
                  <Clock className='h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]' aria-hidden='true' />
                  <span className='shrink-0 font-mono text-[11px] text-[var(--text-muted)]'>{b.start_time}\u2013{b.end_time}</span>
                  <span className='min-w-0 flex-1 truncate text-[13px] text-[var(--text-primary)]'>{b.label}</span>
                  <span className='shrink-0 text-[10px] uppercase tracking-wide text-[var(--text-muted)]'>{b.kind}</span>
                  <button type='button' aria-label={'Edit ' + (b.label || b.title)} data-testid={'day-edit-' + b.id} onClick={() => onEditItem && onEditItem(b)}
                    className='flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-primary)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]'>
                    <Pencil className='h-3.5 w-3.5' aria-hidden='true' />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {dayBlockers.length ? (
          <section className='mb-3'>
            <h4 className={h4}>Blockers</h4>
            <ul className='space-y-1'>
              {dayBlockers.map((b) => (
                <li key={b.id} className='flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1.5' style={{ borderLeft: '3px solid var(--danger)' }}>
                  <Ban className='h-3.5 w-3.5 shrink-0 text-[var(--danger)]' aria-hidden='true' />
                  <span className='min-w-0 flex-1 truncate text-[13px] text-[var(--text-primary)]'>{b.title}</span>
                  <span className='shrink-0 font-mono text-[11px] text-[var(--text-muted)]'>{b.start_date}\u2013{b.end_date || b.start_date}</span>
                  <button type='button' aria-label={'Edit ' + b.title} data-testid={'day-edit-' + b.id} onClick={() => onEditItem && onEditItem(b)}
                    className='flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-primary)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]'>
                    <Pencil className='h-3.5 w-3.5' aria-hidden='true' />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {emptyState ? <p className='py-6 text-center text-[13px] text-[var(--text-muted)]'>Nothing on this day yet.</p> : null}

        <div className='mt-3 flex justify-end'>
          <button type='button' data-testid='day-add' onClick={onAdd}
            className='inline-flex min-h-11 items-center gap-1.5 rounded-full bg-[var(--accent)] px-4 text-[12px] font-semibold text-[var(--bg-primary)] hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]'>
            <Plus className='h-4 w-4' aria-hidden='true' /> Add task / block / blocker
          </button>
        </div>
      </div>
    </div>
  );
}
