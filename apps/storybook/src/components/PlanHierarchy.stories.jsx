import { useState } from 'react';
import { fn } from 'storybook/test';
import { PlanLadder, PlanZoom } from './PlanHierarchy';

/**
 * Plan hierarchy in the canonical vocabulary:
 *   Goal -> Year Plan -> Quarterly Plan -> Monthly Plan -> Weekly Plan ->
 *   Daily Task -> Time Block, with Milestones as an outcome overlay.
 *
 * All presentational - pick a story and react to the layout.
 */
export default {
  title: 'Planner/PlanHierarchy',
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className='mx-auto max-w-3xl p-6 bg-[var(--bg-primary)] text-[var(--text-primary)]'>
        <Story />
      </div>
    ),
  ],
};

const goal = {
  title: 'Switch into platform engineering',
  weekly_hours: 6,
  drift_status: 'on_track',
  target_date: '2027-03-31',
};

const milestones = [
  { id: 'm1', title: 'Foundations done', target_date: '2026-12-15', status: 'done' },
  { id: 'm2', title: '3 mock loops passed', target_date: '2027-01-20', status: 'open' },
  { id: 'm3', title: 'Offer signed', target_date: '2027-03-25', status: 'open' },
];

const nodes = [
  { id: 'n1', level: 'year', title: 'Become a platform engineer', start_date: '2026-10-01', end_date: '2027-03-31', progress: 34 },
  { id: 'n2', level: 'quarter', title: 'Q1 - Foundations', start_date: '2026-10-01', end_date: '2026-12-31', progress: 62 },
  { id: 'n3', level: 'month', title: 'November - Distributed systems', start_date: '2026-11-01', end_date: '2026-11-30', progress: 48 },
  { id: 'n4', level: 'week', title: 'Week 3 - Caching + sharding', start_date: '2026-11-16', end_date: '2026-11-22', progress: 40 },
  { id: 'n5', level: 'day', title: 'Read the caching chapter', done: true, hours: 1 },
  { id: 'n6', level: 'day', title: 'Implement a small cache', hours: 1.5 },
  { id: 'n7', level: 'block', title: 'Deep work - caching lab', hours: 1.5, start_date: '2026-11-17' },
  { id: 'n8', level: 'quarter', title: 'Q2 - Interviews', start_date: '2027-01-01', end_date: '2027-03-31', progress: 8 },
];

export const Ladder = {
  render: (args) => {
    const [n, setN] = useState(args.nodes);
    return (
      <PlanLadder
        goal={args.goal}
        milestones={args.milestones}
        nodes={n}
        onToggle={(id) => setN((prev) => prev.map((x) => (x.id === id ? { ...x, done: !x.done } : x)))}
      />
    );
  },
  args: { goal, milestones, nodes },
};

export const LadderAtRisk = {
  args: {
    goal: { title: 'Run a marathon', weekly_hours: 5, drift_status: 'at_risk', target_date: '2027-01-10' },
    milestones: [
      { id: 'r1', title: 'First 10k', target_date: '2026-11-05', status: 'done' },
      { id: 'r2', title: 'Half marathon', target_date: '2026-12-14', status: 'open' },
    ],
    nodes: [
      { id: 'r3', level: 'year', title: 'Marathon plan', start_date: '2026-10-01', end_date: '2027-01-10', progress: 45 },
      { id: 'r4', level: 'quarter', title: 'Build phase', start_date: '2026-10-01', end_date: '2026-12-31', progress: 52 },
      { id: 'r5', level: 'week', title: 'Week 6 - long run', start_date: '2026-11-16', end_date: '2026-11-22', progress: 30 },
      { id: 'r6', level: 'day', title: 'Interval session 8x400m', hours: 0.75 },
    ],
    onToggle: fn(),
  },
};

const zoomGoals = [
  { id: 'z1', title: 'Platform engineering', start: 0.05, end: 0.75, drift_status: 'on_track' },
  { id: 'z2', title: 'Marathon', start: 0.1, end: 0.55, drift_status: 'at_risk' },
  { id: 'z3', title: 'Spanish B1', start: 0.3, end: 0.95, drift_status: 'on_track' },
];

export const ZoomDefault = {
  render: (args) => <PlanZoom {...args} />,
  args: { initialZoom: 'month', goals: zoomGoals, milestones },
};

export const ZoomYear = {
  render: (args) => <PlanZoom {...args} />,
  args: { initialZoom: 'year', goals: zoomGoals, milestones },
};

export const ZoomDay = {
  render: (args) => <PlanZoom {...args} />,
  args: {
    initialZoom: 'day',
    milestones,
    goals: [
      { id: 'd1', slot: '07:00-08:00', title: 'Deep work - caching' },
      { id: 'd2', slot: '12:30-13:00', title: 'Review flashcards' },
      { id: 'd3', slot: '20:00-21:00', title: 'Read sharding chapter' },
    ],
  },
};
