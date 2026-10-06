import { describe, expect, it } from 'vitest'

import { solveHorizon, type HorizonTask } from '../horizon-solver'

const ALL_DAYS = { mon: 2, tue: 2, wed: 2, thu: 2, fri: 2, sat: 2, sun: 2 }

function task(over: Partial<HorizonTask> = {}): HorizonTask {
  return {
    id: 't1',
    title: 'Read the caching chapter',
    phase: 'Foundations',
    windowStart: '2026-10-05',
    windowEnd: '2026-10-07',
    estHours: 1,
    priority: 3,
    ...over,
  }
}

describe('solveHorizon (whole-plan CP-SAT day placement)', () => {
  it('places a task inside its window and front-loads', async () => {
    const r = await solveHorizon({ availability: ALL_DAYS, tasks: [task()] })
    expect(r.feasible).toBe(true)
    expect(r.slots).toHaveLength(1)
    expect(r.slots[0].date).toBe('2026-10-05')
  })

  it('respects a blocked date', async () => {
    const r = await solveHorizon({
      availability: ALL_DAYS,
      blockedDates: ['2026-10-05', '2026-10-06'],
      tasks: [task({ windowEnd: '2026-10-07' })],
    })
    expect(r.feasible).toBe(true)
    expect(r.slots[0].date).toBe('2026-10-07')
  })

  it('never exceeds per-day availability', async () => {
    const availability = { mon: 1, tue: 1, wed: 1, thu: 1, fri: 1, sat: 1, sun: 1 }
    const r = await solveHorizon({
      availability,
      tasks: [
        task({ id: 'a', windowStart: '2026-10-05', windowEnd: '2026-10-06' }),
        task({ id: 'b', windowStart: '2026-10-05', windowEnd: '2026-10-06' }),
        task({ id: 'c', windowStart: '2026-10-05', windowEnd: '2026-10-06' }),
      ],
    })
    expect(r.slots).toHaveLength(2)
    expect(r.unscheduled).toHaveLength(1)
    expect(r.feasible).toBe(false)
  })

  it('protects higher priority when capacity is short', async () => {
    const availability = { mon: 1, tue: 0, wed: 0, thu: 0, fri: 0, sat: 0, sun: 0 }
    const r = await solveHorizon({
      availability,
      tasks: [
        task({ id: 'low', priority: 1, windowStart: '2026-10-05', windowEnd: '2026-10-05' }),
        task({ id: 'high', priority: 5, windowStart: '2026-10-05', windowEnd: '2026-10-05' }),
      ],
    })
    expect(r.slots.map((s) => s.taskId)).toContain('high')
    expect(r.unscheduled).toContain('low')
  })

  it('returns nothing to schedule for an empty plan', async () => {
    const r = await solveHorizon({ availability: ALL_DAYS, tasks: [] })
    expect(r.feasible).toBe(true)
    expect(r.slots).toHaveLength(0)
  })
})
