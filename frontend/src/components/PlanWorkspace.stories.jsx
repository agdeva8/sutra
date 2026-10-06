import { fn } from 'storybook/test';
import { PlanWorkspace } from './PlanWorkspace';

export default {
  title: 'Planner/PlanWorkspace',
  component: PlanWorkspace,
  tags: ['autodocs'],
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <div className='mx-auto max-w-4xl p-6 bg-[var(--bg-primary)] text-[var(--text-primary)]'>
        <Story />
      </div>
    ),
  ],
};

const day = (o) => { const d = new Date(); d.setDate(d.getDate() + o); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

// ---- Goal 1: career ------------------------------------------------------
const g1 = { id: 'g1', title: 'Switch into platform engineering', weekly_hours: 6, drift_status: 'on_track', start_date: day(-10), target_date: day(150) };
const g1Milestones = [
  { id: 'g1m1', goal_id: 'g1', title: 'Foundations done', target_date: day(30), status: 'done' },
  { id: 'g1m2', goal_id: 'g1', title: '3 mock loops passed', target_date: day(80), status: 'open' },
  { id: 'g1m3', goal_id: 'g1', title: 'Offer signed', target_date: day(145), status: 'open' },
];
const g1Nodes = [
  { id: 'a1', level: 'year', title: 'Platform engineer', start_date: day(-10), end_date: day(150), progress: 30 },
  { id: 'a2', level: 'quarter', title: 'Q1 - Foundations', start_date: day(-10), end_date: day(60), progress: 55 },
  { id: 'a3', level: 'month', title: 'Distributed systems', start_date: day(0), end_date: day(30), progress: 40 },
  { id: 'a4', level: 'week', title: 'Week 3 - caching', start_date: day(0), end_date: day(6), progress: 50 },
  { id: 'a5', level: 'day', title: 'Read the caching chapter', done: true, hours: 1 },
  { id: 'a6', level: 'day', title: 'Implement a small cache', hours: 1.5 },
  { id: 'a7', level: 'block', title: 'Deep work - caching lab', hours: 1.5, start_date: day(1) },
  { id: 'a8', level: 'week', title: 'Week 4 - sharding', start_date: day(7), end_date: day(13), progress: 0 },
  { id: 'a9', level: 'day', title: 'Read the sharding chapter', hours: 1 },
  { id: 'a10', level: 'day', title: 'Sketch a sharding design', hours: 2 },
  { id: 'a11', level: 'month', title: 'Interview prep', start_date: day(31), end_date: day(60), progress: 0 },
  { id: 'a12', level: 'week', title: 'Week 5 - mock loops', start_date: day(14), end_date: day(20), progress: 0 },
  { id: 'a13', level: 'day', title: 'Run a system-design mock', hours: 1 },
  { id: 'a14', level: 'quarter', title: 'Q2 - Interviews', start_date: day(61), end_date: day(150), progress: 5 },
];

// ---- Goal 2: health ------------------------------------------------------
const g2 = { id: 'g2', title: 'Run a half marathon', weekly_hours: 5, drift_status: 'at_risk', start_date: day(-5), target_date: day(90) };
const g2Milestones = [
  { id: 'g2m1', goal_id: 'g2', title: 'First 10k', target_date: day(35), status: 'open' },
  { id: 'g2m2', goal_id: 'g2', title: 'Half marathon', target_date: day(88), status: 'open' },
];
const g2Nodes = [
  { id: 'b1', level: 'year', title: 'Half marathon', start_date: day(-5), end_date: day(90), progress: 22 },
  { id: 'b2', level: 'quarter', title: 'Base building', start_date: day(-5), end_date: day(45), progress: 38 },
  { id: 'b3', level: 'month', title: 'Volume month', start_date: day(0), end_date: day(30), progress: 30 },
  { id: 'b4', level: 'week', title: 'Week 3 - tempo', start_date: day(0), end_date: day(6), progress: 40 },
  { id: 'b5', level: 'day', title: 'Tempo run 5k', done: true, hours: 0.75 },
  { id: 'b6', level: 'day', title: 'Cross-train', hours: 0.5 },
  { id: 'b7', level: 'week', title: 'Week 4 - long run', start_date: day(7), end_date: day(13), progress: 0 },
  { id: 'b8', level: 'day', title: 'Long run 14k', hours: 1.5 },
  { id: 'b9', level: 'block', title: 'Morning long run', hours: 1.5, start_date: day(8) },
  { id: 'b10', level: 'quarter', title: 'Race block', start_date: day(46), end_date: day(90), progress: 5 },
];

// ---- Goal 3: learning ----------------------------------------------------
const g3 = { id: 'g3', title: 'Learn Spanish to B1', weekly_hours: 4, drift_status: 'on_track', start_date: day(-15), target_date: day(200) };
const g3Milestones = [
  { id: 'g3m1', goal_id: 'g3', title: 'A2 grammar done', target_date: day(40), status: 'done' },
  { id: 'g3m2', goal_id: 'g3', title: 'Hold a 10-min chat', target_date: day(110), status: 'open' },
];
const g3Nodes = [
  { id: 'c1', level: 'year', title: 'Spanish B1', start_date: day(-15), end_date: day(200), progress: 18 },
  { id: 'c2', level: 'quarter', title: 'Q1 - Vocab + grammar', start_date: day(-15), end_date: day(70), progress: 40 },
  { id: 'c3', level: 'month', title: 'Present tense', start_date: day(0), end_date: day(30), progress: 35 },
  { id: 'c4', level: 'week', title: 'Week 4 - verbs', start_date: day(7), end_date: day(13), progress: 0 },
  { id: 'c5', level: 'day', title: 'Anki deck 30 cards', done: true, hours: 0.5 },
  { id: 'c6', level: 'day', title: 'Tutor session', hours: 1 },
  { id: 'c7', level: 'block', title: 'Tutor call', hours: 1, start_date: day(8) },
];

const goals = [
  { id: 'g1', title: 'Platform engineering', start_date: day(-10), target_date: day(150), drift_status: 'on_track' },
  { id: 'g2', title: 'Half marathon', start_date: day(-5), target_date: day(90), drift_status: 'at_risk' },
  { id: 'g3', title: 'Spanish B1', start_date: day(-15), target_date: day(200), drift_status: 'on_track' },
];
const milestones = [...g1Milestones, ...g2Milestones, ...g3Milestones];
const blockers = [{ id: 'bk1', title: 'Sibling wedding', start_date: day(20), end_date: day(23) }];
const blocks = [
  { id: 'bl0', goal_id: 'g1', label: 'Deep work', block_date: day(0), start_time: '07:00', end_time: '08:30', kind: 'focus' },
  { id: 'bl1', label: 'Deep work', block_date: day(1), start_time: '07:00', end_time: '08:30', kind: 'focus' },
  { id: 'bl2', label: 'Morning run', block_date: day(1), start_time: '06:00', end_time: '07:00', kind: 'routine' },
  { id: 'bl3', label: 'Tutor call', block_date: day(2), start_time: '19:00', end_time: '20:00', kind: 'commitment' },
];

// Weeks start COLLAPSED - click a Week Plan's arrow to reveal its tasks.
const plans = [
  { id: 'p1', goal: g1, nodes: g1Nodes, milestones: g1Milestones },
  { id: 'p2', goal: g2, nodes: g2Nodes, milestones: g2Milestones },
  { id: 'p3', goal: g3, nodes: g3Nodes, milestones: g3Milestones },
];

export const ThreeGoals = { args: { plans, goals, milestones, blockers, blocks, onEventClick: fn() } };

// Same data, but "Week 4" pre-expanded on every goal so its tasks are visible.
const plansWeek4 = [
  { id: 'p1', goal: g1, nodes: g1Nodes, milestones: g1Milestones, defaultExpanded: ['a1', 'a2', 'a3', 'a8'] },
  { id: 'p2', goal: g2, nodes: g2Nodes, milestones: g2Milestones, defaultExpanded: ['b1', 'b2', 'b3', 'b7'] },
  { id: 'p3', goal: g3, nodes: g3Nodes, milestones: g3Milestones, defaultExpanded: ['c1', 'c2', 'c3', 'c4'] },
];
export const Week4Expanded = { args: { plans: plansWeek4, goals, milestones, blockers, blocks, onEventClick: fn() } };

export const Interactive = { args: { plans, goals, milestones, blockers, blocks, onEventClick: fn() } };
