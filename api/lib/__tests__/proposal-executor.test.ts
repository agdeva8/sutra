import { beforeEach, describe, expect, it, vi } from 'vitest'

import * as schema from '@/db/schema'

import { applyProposal } from '../proposal-executor'

/**
 * Fake DB that captures every `insert(...).values(...)` and resolves goal
 * lookups to a single fixed row, so the executor's `resolveGoalRef` title path
 * works without a real connection. We do NOT mock `@/db/schema` — the real
 * drizzle columns are needed for `eq(...)` to build.
 */
const mocks = vi.hoisted(() => {
  const captured: Array<{ table: unknown; values: any }> = []
  const updated: Array<{ table: unknown; values: any }> = []
  const goalRow = {
    id: 'goal_1',
    title: 'T',
    status: 'active',
    weeklyHours: 6,
  }
  const tx = {
    update: (table: unknown) => ({
      set: (values: any) => {
        updated.push({ table, values })
        return { where: async () => undefined }
      },
    }),
    delete: () => ({ where: async () => undefined }),
    insert: (table: unknown) => ({
      values: async (values: any) => {
        captured.push({ table, values })
      },
    }),
  }
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => [goalRow],
  }
  const db = {
    select: () => chain,
    transaction: async (cb: (t: unknown) => Promise<unknown>) => cb(tx),
  }
  return { captured, updated, db }
})

vi.mock('@/lib/db', () => ({ db: mocks.db }))

function insertedFor(table: unknown): any {
  return mocks.captured.find((c) => c.table === table)?.values
}

describe('applyProposal — Goal Planner field persistence (Iteration 10)', () => {
  beforeEach(() => {
    mocks.captured.length = 0
    mocks.updated.length = 0
  })

  it('create_goal persists weekly_hours, phase_objectives, life_area', async () => {
    const res = await applyProposal('u1', {
      id: 'p1',
      action: 'create_goal',
      args: {
        title: 'Switch to senior SDE',
        horizon: 'short',
        weekly_hours: 7.5,
        phase_objectives: { Foundations: 'x', Mocks: 'y' },
        life_area: 'Career',
      },
    })
    expect(res.success).toBe(true)
    const goal = insertedFor(schema.goals)
    expect(goal.weeklyHours).toBe(8) // 7.5 rounded to the integer column
    expect(goal.phaseObjectives).toEqual({ Foundations: 'x', Mocks: 'y' })
    expect(goal.lifeArea).toBe('Career')
  })

  it('create_goal tolerates the legacy shape (no plan fields)', async () => {
    await applyProposal('u1', {
      id: 'p2',
      action: 'create_goal',
      args: { title: 'Legacy goal', horizon: 'medium' },
    })
    const goal = insertedFor(schema.goals)
    expect(goal.weeklyHours).toBeNull()
    expect(goal.phaseObjectives).toEqual({})
    expect(goal.lifeArea).toBe('')
  })

  it('attaches temporary source ids to the confirmed goal', async () => {
    await applyProposal('u1', {
      id: 'p-source-goal',
      action: 'create_goal',
      args: {
        title: 'Source-grounded goal',
        horizon: 'short',
        source_ids: ['src_1'],
      },
    })
    expect(mocks.updated).toContainEqual({
      table: schema.sources,
      values: { goalId: expect.any(String), goalTitle: 'Source-grounded goal', expiresAt: null },
    })
  })

  it('add_milestone persists phase', async () => {
    const res = await applyProposal('u1', {
      id: 'p3',
      action: 'add_milestone',
      args: { goal_title: 'T', title: 'SD fundamentals', target_date: '2026-11-05', phase: 'Foundations' },
    })
    expect(res.success).toBe(true)
    expect(insertedFor(schema.milestones).phase).toBe('Foundations')
    expect(insertedFor(schema.milestones).goalId).toBe('goal_1')
  })

  it('add_block creates a plan-sourced timetable block and resolves its goal', async () => {
    const res = await applyProposal('u1', {
      id: 'p-block',
      action: 'add_block',
      args: {
        block_date: '2026-10-05',
        start_time: '09:00',
        end_time: '10:30',
        label: 'System design practice',
        kind: 'focus',
        goal_title: 'T',
      },
    })
    expect(res.success).toBe(true)
    expect(insertedFor(schema.timetableBlocks)).toMatchObject({
      userId: 'u1',
      blockDate: '2026-10-05',
      startTime: '09:00',
      endTime: '10:30',
      label: 'System design practice',
      kind: 'focus',
      source: 'plan',
      goalId: 'goal_1',
    })
  })

  it('rejects an invalid timetable range without writing', async () => {
    const res = await applyProposal('u1', {
      id: 'p-bad-block',
      action: 'add_block',
      args: {
        block_date: '2026-10-05',
        start_time: '10:30',
        end_time: '09:00',
        label: 'Invalid block',
        kind: 'focus',
      },
    })
    expect(res.success).toBe(false)
    expect(mocks.captured.some((row) => row.table === schema.timetableBlocks)).toBe(false)
  })

  it('pause_goal audits the capacity freed for the opt-in re-plan suggestion', async () => {
    const res = await applyProposal('u1', {
      id: 'p-pause',
      action: 'pause_goal',
      args: { goal_title: 'T', reason: 'Taking a break' },
    })
    expect(res.success).toBe(true)
    const audit = mocks.captured.find((c) => c.table === schema.auditLog)?.values
    expect(audit.payload).toMatchObject({
      goal_id: 'goal_1',
      goal_title: 'T',
      freed_weekly_hours: 6,
    })
  })

  it('update_goal pause also records freed capacity', async () => {
    const res = await applyProposal('u1', {
      id: 'p-update-pause',
      action: 'update_goal',
      args: { goal_title: 'T', status: 'paused' },
    })
    expect(res.success).toBe(true)
    const audit = mocks.captured.find((c) => c.table === schema.auditLog)?.values
    expect(audit.payload).toMatchObject({
      goal_id: 'goal_1',
      freed_weekly_hours: 6,
    })
  })

  it('update_goal status=dropped routes through the cascade', async () => {
    const res = await applyProposal('u1', {
      id: 'p-update-drop',
      action: 'update_goal',
      args: { goal_title: 'T', status: 'dropped' },
    })
    expect(res.success).toBe(true)
    const audit = mocks.captured.find((c) => c.table === schema.auditLog)?.values
    expect(audit.type).toBe('confirm:drop_goal')
    expect(audit.payload).toMatchObject({ goal_id: 'goal_1', goal_title: 'T' })
  })

  it('set_goal_dates audits the resolved goal id for infeasibility checks', async () => {
    const res = await applyProposal('u1', {
      id: 'p-dates',
      action: 'set_goal_dates',
      args: { goal_title: 'T', target_date: '2026-10-01' },
    })
    expect(res.success).toBe(true)
    const audit = mocks.captured.find((c) => c.table === schema.auditLog)?.values
    expect(audit.payload).toMatchObject({
      goal_id: 'goal_1',
      goal_title: 'T',
      args: { target_date: '2026-10-01' },
    })
  })
})
