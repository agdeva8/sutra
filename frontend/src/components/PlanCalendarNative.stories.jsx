import { fn } from 'storybook/test';
import { PlanCalendarNative } from './PlanCalendarNative';

export default {
  title: 'Planner/PlanCalendarNative',
  component: PlanCalendarNative,
  tags: ['autodocs'],
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <div className='bg-[var(--bg-primary)] p-4 text-[var(--text-primary)]'>
        <Story />
      </div>
    ),
  ],
};

const day = (o) => { const d = new Date(); d.setDate(d.getDate() + o); return d.toISOString().slice(0, 10); };
const goals = [
  { id: 'g1', title: 'Switch into platform engineering', start_date: day(-10), target_date: day(150) },
  { id: 'g2', title: 'Run a half marathon', start_date: day(-5), target_date: day(90) },
  { id: 'g3', title: 'Learn Spanish to B1', start_date: day(-15), target_date: day(200) },
];
const milestones = [
  { id: 'm1', goal_id: 'g1', title: 'Foundations done', target_date: day(30), status: 'done' },
  { id: 'm2', goal_id: 'g1', title: '3 mock loops', target_date: day(80), status: 'open' },
  { id: 'm3', goal_id: 'g2', title: 'First 10k', target_date: day(35), status: 'open' },
  { id: 'm4', goal_id: 'g3', title: '10-min chat', target_date: day(110), status: 'open' },
];
const blockers = [{ id: 'b1', title: 'Sibling wedding', start_date: day(20), end_date: day(23) }];
const blocks = [
  { id: 'bl1', goal_id: 'g1', label: 'Deep work', block_date: day(1), start_time: '07:00', end_time: '08:30', kind: 'focus' },
  { id: 'bl2', goal_id: 'g2', label: 'Morning run', block_date: day(1), start_time: '06:00', end_time: '07:00', kind: 'routine' },
];

export const Month = { args: { goals, milestones, blockers, blocks, onSelectItem: fn(), onSelectDay: fn() } };
export const Empty = { args: { goals: [], milestones: [], blockers: [], blocks: [] } };
