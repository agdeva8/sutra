import { describe, expect, it, vi } from 'vitest'

import * as schema from '@/db/schema'

import {
  applyGoalDropCascade,
  computeGoalDropImpact,
  dropImpactSentence,
  resolveGoalRef,
} from '../goal-drop'

/* -------------------------------------------------------------------------- */
/* Fake DB                                                                    */
/*                                                                            */
/* `.select().from(t)` dispatches by table identity (order-independent, so the */
/* Promise.all in computeGoalDropImpact works). Every read ends in `.limit()`. */
/* -------------------------------------------------------------------------- */

function nameOf(t: unknown): string {
  if (t === schema.goals) return 'goals'
  if (t === schema.milestones) return 'milestones'
  if (t === schema.timetableBlocks) return 'timetableBlocks'
  if (t === schema.users) return 'users'
  if (t === schema.auditLog) return 'auditLog'
  return 'other'
}

interface Captured {
  updates: Array<{ table: string; values: any }>
  deletes: string[]
  inserts: Array<{ table: string; values: any }>
  transactions: number
}

function makeDb(rows: Record<string, any[]>): { db: any; captured: Captured } {
  const captured: Captured = { updates: [], deletes: [], inserts: [], transactions: 0 }

  const select = () =>
    (() => {
      let key = 'other'
      const chain: any = {
        from(t: unknown) {
          key = nameOf(t)
          return chain
        },
        where() {
          return chain
        },
        orderBy() {
          return chain
        },
        limit() {
          return Promise.resolve(rows[key] ?? [])
        },
      }
      return chain
    })()

  const writeTx = {
    update(t: unknown) {
      const key = nameOf(t)
      return {
        set(values: any) {
          captured.updates.push({ table: key, values })
          return { where: () => Promise.resolve() }
        },
      }
    },
    delete(t: unknown) {
      captured.deletes.push(nameOf(t))
      return { where: () => Promise.resolve() }
    },
    insert(t: unknown) {
      const key = nameOf(t)
      return {
        values(values: any) {
          captured.inserts.push({ table: key, values })
          return Promise.resolve()
        },
      }
    },
  }

  const db = {
    select,
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
      captured.transactions++
      return cb(writeTx)
    },
  }
  return { db, captured }
}

const GOAL_ID = 'goal_1'

function baseRows() {
  return {
    goals: [
      { id: GOAL_ID, title: 'Learn Spanish', weeklyHours: 8, status: 'active' },
      { id: 'goal_2', title: 'Run a half', weeklyHours: 5, status: 'active' },
    ],
    milestones: [{ id: 'm1', title: 'A1 reached', targetDate: '2026-03-01' }],
    timetableBlocks: [
      {
        id: 'b1',
        label: 'Study 90m',
        blockDate: '2026-01-05',
        startTime: '09:00:00',
        endTime: '10:30:00',
      },
    ],
    users: [{ availableWeeklyHours: 40 }],
    auditLog: [],
  }
}

/* -------------------------------------------------------------------------- */

describe('computeGoalDropImpact', () => {
  it('counts children, freed hours, and the before/after load', async () => {
    const { db } = makeDb(baseRows())
    const impact = await computeGoalDropImpact(db, schema, 'u1', {
      goalId: GOAL_ID,
      goalTitle: 'Learn Spanish',
    })

    expect(impact.goal_title).toBe('Learn Spanish')
    expect(impact.counts).toEqual({
      milestones: 1,
      timetable_blocks: 1,
    })
    expect(impact.freed_weekly_hours).toBe(8)
    expect(impact.load_before).toBe(13) // 8 + 5
    expect(impact.load_after).toBe(5)
    expect(impact.budget_hours).toBe(40)
    expect(impact.other_active_goals).toBe(1)
    expect(impact.timetable_blocks[0]).toMatchObject({
      label: 'Study 90m',
      start_time: '09:00',
      end_time: '10:30',
    })
  })

  it('dropImpactSentence names the cleanup + freed hours', async () => {
    const { db } = makeDb(baseRows())
    const impact = await computeGoalDropImpact(db, schema, 'u1', {
      goalId: GOAL_ID,
      goalTitle: 'Learn Spanish',
    })
    const sentence = dropImpactSentence(impact)
    expect(sentence).toContain('Learn Spanish')
    expect(sentence).toContain('1 milestone')
    expect(sentence).toContain('1 scheduled block')
    expect(sentence).toContain('8h/week')
  })
})

describe('applyGoalDropCascade', () => {
  it('drops the goal, deletes scaffolding, audits once', async () => {
    const { db, captured } = makeDb(baseRows())
    const { result } = await applyGoalDropCascade(
      db,
      schema,
      'u1',
      { goalId: GOAL_ID, goalTitle: 'Learn Spanish' },
      { auditType: 'confirm:drop_goal' },
    )

    expect(captured.transactions).toBe(1)

    const goalUpdate = captured.updates.find((u) => u.table === 'goals')
    expect(goalUpdate?.values.status).toBe('dropped')

    expect(captured.deletes).toContain('milestones')
    expect(captured.deletes).toContain('timetableBlocks')

    const audit = captured.inserts.find((i) => i.table === 'auditLog')
    expect(audit?.values.type).toBe('confirm:drop_goal')
    expect(audit?.values.payload).toMatchObject({
      goal_id: GOAL_ID,
      goal_title: 'Learn Spanish',
      freed_weekly_hours: 8,
    })

    expect(result).toContain("Dropped goal 'Learn Spanish'")
    expect(result).toContain('freed 8h/week')
  })

  it('still audits a goal with no children', async () => {
    const rows = baseRows()
    rows.milestones = []
    rows.timetableBlocks = []
    const { db, captured } = makeDb(rows)
    const { result } = await applyGoalDropCascade(
      db,
      schema,
      'u1',
      { goalId: GOAL_ID, goalTitle: 'Learn Spanish' },
      { auditType: 'drop:goal' },
    )
    expect(captured.inserts.find((i) => i.table === 'auditLog')).toBeTruthy()
    expect(result).toContain("Dropped goal 'Learn Spanish'")
    expect(result).not.toContain('cleaned up')
  })
})

describe('resolveGoalRef', () => {
  it('resolves by id first', async () => {
    const { db } = makeDb(baseRows())
    const ref = await resolveGoalRef(db, schema, 'u1', { goal_id: GOAL_ID })
    expect(ref).toEqual({ goalId: GOAL_ID, goalTitle: 'Learn Spanish' })
  })

  it('falls back to exact case-insensitive title', async () => {
    const { db } = makeDb(baseRows())
    const ref = await resolveGoalRef(db, schema, 'u1', {
      goal_title: 'learn spanish',
    })
    expect(ref?.goalId).toBe(GOAL_ID)
  })

  it('returns null when nothing matches', async () => {
    const { db } = makeDb(baseRows())
    const ref = await resolveGoalRef(db, schema, 'u1', {
      goal_title: 'nope nope nope',
    })
    expect(ref).toBeNull()
  })
})

void vi
