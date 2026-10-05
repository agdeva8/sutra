import { describe, expect, it } from 'vitest'

import { computeDrift, isoMinusDays } from '../drift'

describe('isoMinusDays', () => {
  it('subtracts across a month boundary without TZ drift', () => {
    expect(isoMinusDays('2026-10-03', 7)).toBe('2026-09-26')
    expect(isoMinusDays('2026-01-01', 1)).toBe('2025-12-31')
  })
})

describe('computeDrift', () => {
  it('is on_track when nothing has slipped', () => {
    const r = computeDrift({
      today: '2026-10-10',
      milestones: [{ title: 'M1', targetDate: '2026-11-01', status: 'open' }],
    })
    expect(r.status).toBe('on_track')
    expect(r.reasons).toEqual([])
  })

  it('flags an overdue incomplete milestone', () => {
    const r = computeDrift({
      today: '2026-10-10',
      milestones: [
        { title: 'Pass 5 mocks', targetDate: '2026-10-05', status: 'open' },
      ],
    })
    expect(r.status).toBe('at_risk')
    expect(r.reasons[0]).toContain('Pass 5 mocks')
  })

  it('does not flag a milestone that is overdue but done', () => {
    const r = computeDrift({
      today: '2026-10-10',
      milestones: [
        { title: 'Pass 5 mocks', targetDate: '2026-10-05', status: 'done' },
      ],
    })
    expect(r.status).toBe('on_track')
  })
})
