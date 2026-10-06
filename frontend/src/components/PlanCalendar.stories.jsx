import { fn } from 'storybook/test';
import { PlanCalendar } from './PlanCalendar';

export default {
  title: 'Planner/PlanCalendar',
  component: PlanCalendar,
  tags: ['autodocs'],
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <div className='mx-auto max-w-5xl p-6 bg-[var(--bg-primary)] text-[var(--text-primary)]'>
        <Story />
      </div>
    ),
  ],
};

const day = (o) => { const d = new Date(); d.setDate(d.getDate() + o); return d.toISOString().slice(0, 10); };

const goals = [
  { id: 'g1', title: 'Platform engineering', start_date: day(-20), target_date: day(120), drift_status: 'on_track' },
  { id: 'g2', title: 'Run a marathon', start_date: day(-5), target_date: day(70), drift_status: 'at_risk' },
];
const milestones = [
  { id: 'm1', title: 'SD fundamentals', target_date: day(14), status: 'open' },
  { id: 'm2', title: 'Half marathon', target_date: day(48), status: 'open' },
  { id: 'm3', title: 'CV approved', target_date: day(-3), status: 'done' },
];
const blockers = [
  { id: 'b1', title: 'Sibling wedding', start_date: day(20), end_date: day(23) },
];
const blocks = [
  { id: 'bl1', label: 'Deep work', block_date: day(1), start_time: '07:00', end_time: '08:30', kind: 'focus' },
  { id: 'bl2', label: 'Mock interview', block_date: day(2), start_time: '18:00', end_time: '19:00', kind: 'commitment' },
];

const base = { goals, milestones, blockers, blocks, onEventClick: fn() };

export const YearMultiMonth = { args: { ...base, initialView: 'multiMonthYear' } };
export const Month = { args: { ...base, initialView: 'dayGridMonth' } };
export const Week = { args: { ...base, initialView: 'timeGridWeek' } };
export const Day = { args: { ...base, initialView: 'timeGridDay' } };
export const List = { args: { ...base, initialView: 'listWeek' } };
export const Empty = { args: { goals: [], milestones: [], blockers: [], blocks: [] } };
