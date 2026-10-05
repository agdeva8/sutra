import { describe, expect, it } from 'vitest'

import { schedulePlan, weekdayOf, WEEKDAYS } from '../schedule'

const WEEK_START = '2026-10-05' // a Monday

describe('weekdayOf', () => {
  it('maps ISO dates to Mon-first weekday keys', () => {
    expect(weekdayOf('2026-10-05')).toBe('mon')
    expect(weekdayOf('2026-10-10')).toBe('sat')
    expect(weekdayOf('2026-10-11')).toBe('sun')
    expect(WEEKDAYS).toHaveLength(7)
  })
})

describe('schedulePlan (week scope)', () => {
  it('places items within the week and respects per-day capacity', async () => {
    const r = await schedulePlan({
      scope: 'week',
      weekStart: WEEK_START,
      availability: { mon: 2, tue: 2, wed: 2, thu: 2, fri: 2 },
      items: [
        { id: 'a', priority: 5, estHours: 1.5, order: 0 },
        { id: 'b', priority: 4, estHours: 1.5, order: 1 },
        { id: 'c', priority: 3, estHours: 2, order: 2 },
      ],
    })
    expect(r.feasible).toBe(true)
    expect(r.unscheduled).toEqual([])
    expect(r.slots).toHaveLength(3)

    // Every slot lands on a Mon–Fri date of this week.
    const dates = new Set([
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
      '2026-10-08',
      '2026-10-09',
    ])
    for (const s of r.slots) expect(dates.has(s.date)).toBe(true)

    // Per-day load never exceeds the 2h capacity.
    const perDay = new Map<string, number>()
    for (const s of r.slots) perDay.set(s.date, (perDay.get(s.date) ?? 0) + s.hours)
    for (const h of perDay.values()) expect(h).toBeLessThanOrEqual(2 + 1e-9)

    // Precedence: `a` (order 0) is not after `b`, and `b` not after `c`.
    const day = new Map(r.slots.map((s) => [s.itemId, s.date]))
    expect(day.get('a')! <= day.get('b')!).toBe(true)
    expect(day.get('b')! <= day.get('c')!).toBe(true)
  })

  it('reports items that exceed the week capacity as unscheduled', async () => {
    const r = await schedulePlan({
      scope: 'week',
      weekStart: WEEK_START,
      availability: { mon: 2 }, // 2h all week — room for exactly one item
      items: [
        { id: 'a', priority: 5, estHours: 2 },
        { id: 'b', priority: 3, estHours: 2 },
      ],
    })
    expect(r.feasible).toBe(false)
    expect(r.unscheduled.length).toBe(1)
    // The higher-priority item survives.
    expect(r.unscheduled).not.toContain('a')
    expect(r.slots.some((s) => s.itemId === 'a')).toBe(true)
  })

  it('gives zero capacity to blocked dates', async () => {
    const r = await schedulePlan({
      scope: 'week',
      weekStart: WEEK_START,
      availability: { mon: 4, tue: 4 },
      blockedDates: ['2026-10-05'], // block Monday
      items: [{ id: 'a', priority: 5, estHours: 3 }],
    })
    expect(r.slots).toHaveLength(1)
    expect(r.slots[0].date).not.toBe('2026-10-05')
    expect(r.slots[0].date).toBe('2026-10-06')
  })

  it('returns an empty result when there is nothing to schedule', async () => {
    const r = await schedulePlan({
      scope: 'week',
      weekStart: WEEK_START,
      availability: { mon: 2 },
      items: [],
    })
    expect(r.slots).toEqual([])
    expect(r.unscheduled).toEqual([])
  })
})
