import { describe, expect, it } from 'vitest'

import { crossValidate } from '../cross-validator'
import type { Emit, Plan } from '../schemas'

const TITLE = 'Land a senior SDE offer'

const plan: Plan = {
  goal: {
    title: TITLE,
    horizon: 'short',
    why: 'algorithmic base is there; SD + behavioral are the gaps',
    first_action: 'Pick a SD resource and read Ch 1',
    start_date: '2026-10-01',
    target_date: '2027-01-29',
    weekly_hours: 7.5,
    phase_objectives: {
      Foundations: 'SD Ch 1-12, 8 STAR stories',
      Mocks: '5 SD mocks passed with feedback',
      Active: 'Offer in hand',
    },
  },
  milestones: [
    {
      title: 'SD fundamentals locked',
      target_date: '2026-11-05',
      phase: 'Foundations',
      rationale: '35d gate',
    },
    {
      title: '5 SD mocks passed',
      target_date: '2026-12-17',
      phase: 'Mocks',
      rationale: '77d gate',
    },
    {
      title: 'Offer in hand',
      target_date: '2027-01-29',
      phase: 'Active',
      rationale: 'the goal',
    },
  ],
  blockers: [],
  blocks: [],
  prose: 'The daily 90-min slot is the load-bearing constraint.',
}

const validEmit: Emit = {
  tools: [
    {
      action: 'create_goal',
      args: {
        title: TITLE,
        horizon: 'short',
        target_date: '2027-01-29',
        weekly_hours: 7.5,
        phase_objectives: {
          Foundations: 'SD Ch 1-12, 8 STAR stories',
          Mocks: '5 SD mocks passed with feedback',
          Active: 'Offer in hand',
        },
      },
    },
    {
      action: 'add_milestone',
      args: {
        goal_title: TITLE,
        title: 'SD fundamentals locked',
        target_date: '2026-11-05',
        phase: 'Foundations',
      },
    },
  ],
}

const base = { intent: 'add_goal' as const, plan, existingGoalTitles: [] }

describe('crossValidate — add_goal', () => {
  it('accepts a coherent emit', () => {
    const r = crossValidate({ ...base, emit: validEmit })
    expect(r.errors).toEqual([])
    expect(r.ok).toBe(true)
  })

  it('rejects an action outside the intent allowlist', () => {
    const r = crossValidate({
      ...base,
      emit: {
        tools: [{ action: 'drop_goal', args: { goal_title: TITLE } }],
      },
    })
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toContain("not allowed for intent 'add_goal'")
  })

  it('rejects a create_goal title that does not match the plan', () => {
    const r = crossValidate({
      ...base,
      emit: {
        tools: [
          {
            action: 'create_goal',
            args: { title: 'Something else', horizon: 'short' },
          },
        ],
      },
    })
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toContain('does not match plan.goal.title')
  })

  it('rejects an add_milestone date not in the plan', () => {
    const r = crossValidate({
      ...base,
      emit: {
        tools: [
          {
            action: 'add_milestone',
            args: {
              goal_title: TITLE,
              title: 'SD fundamentals locked',
              target_date: '2026-11-06',
              phase: 'Foundations',
            },
          },
        ],
      },
    })
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toContain('is not in plan.milestones')
  })

  it('rejects an add_milestone phase that is not a phase_objectives key', () => {
    const r = crossValidate({
      ...base,
      emit: {
        tools: [
          {
            action: 'add_milestone',
            args: {
              goal_title: TITLE,
              title: 'SD fundamentals locked',
              target_date: '2026-11-05',
              phase: 'MadeUpPhase',
            },
          },
        ],
      },
    })
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toContain('not a key in plan.goal.phase_objectives')
  })

  it('rejects an invented blocker (LLM must not invent blockers)', () => {
    const r = crossValidate({
      ...base,
      emit: {
        tools: [
          {
            action: 'add_blocker',
            args: { title: 'Travel', start_date: '2026-11-01', end_date: '2026-11-05' },
          },
        ],
      },
    })
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toContain('must not invent blockers')
  })

  it('enforces the 3-8 milestone bounds for add_goal', () => {
    const thinPlan: Plan = { ...plan, milestones: plan.milestones.slice(0, 2) }
    const r = crossValidate({ ...base, plan: thinPlan, emit: validEmit })
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toContain('requires 3-8 milestones')
  })

  it('accepts a plan-day block only when it matches the plan', () => {
    const block = {
      block_date: '2026-10-05',
      start_time: '09:00',
      end_time: '10:30',
      label: 'System design practice',
      kind: 'focus' as const,
      goal_title: TITLE,
    }
    const dayPlan: Plan = {
      ...plan,
      goal: null,
      milestones: [],
      blockers: [],
      blocks: [block],
    }
    const emit: Emit = { tools: [{ action: 'add_block', args: block }] }
    const result = crossValidate({ intent: 'plan_day', plan: dayPlan, emit, today: '2026-10-03', existingGoalTitles: [TITLE] })
    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('rejects overlapping plan-day blocks', () => {
    const block = {
      block_date: '2026-10-05',
      start_time: '09:00',
      end_time: '10:30',
      label: 'System design practice',
      kind: 'focus' as const,
    }
    const result = crossValidate({
      intent: 'plan_day',
      plan: {
        ...plan,
        goal: null,
        milestones: [],
        blockers: [],
        blocks: [block, { ...block, start_time: '10:00', end_time: '11:00', label: 'Application work' }],
      },
      emit: { tools: [{ action: 'add_block', args: block }] },
      existingGoalTitles: [],
    })
    expect(result.errors.join(' ')).toContain('blocks overlap')
  })

  it('rejects timetable blocks outside the three-day planning window', () => {
    const block = {
      block_date: '2026-10-06',
      start_time: '09:00',
      end_time: '10:30',
      label: 'System design practice',
      kind: 'focus' as const,
    }
    const result = crossValidate({
      intent: 'plan_day',
      plan: { ...plan, goal: null, milestones: [], blockers: [], blocks: [block] },
      emit: { tools: [{ action: 'add_block', args: block }] },
      today: '2026-10-03',
      existingGoalTitles: [],
    })
    expect(result.errors.join(' ')).toContain('within the next 2 days')
  })
})
