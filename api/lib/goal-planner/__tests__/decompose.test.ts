import { describe, expect, it, vi } from 'vitest'

import { decomposeAndScheduleWeek } from '../decompose'
import type { CompleteFn } from '../orchestrator'

const WEEK = '2026-10-05' // a Monday
const availability = { mon: 2, tue: 2, wed: 2, thu: 2, fri: 2 }
const WEEK_DATES = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09']

describe('decomposeAndScheduleWeek', () => {
  it('splits a week into distinct days via the LLM and schedules them', async () => {
    const complete = vi.fn(async () => ({
      object: {
        steps: [
          { title: 'Read the caching chapter', hours: 1.5 },
          { title: 'Implement a cache', hours: 2 },
        ],
      },
      meta: { mode: 'object' },
    })) as unknown as CompleteFn

    const r = await decomposeAndScheduleWeek({
      weekStart: WEEK,
      weekLabel: 'Complete system design',
      weeklyHours: 4,
      availability,
      provider: 'gemini',
      complete,
    })

    expect(r.days.map((d) => d.title)).toEqual([
      'Read the caching chapter',
      'Implement a cache',
    ])
    for (const d of r.days) expect(WEEK_DATES).toContain(d.date)
  })

  it('falls back to a deterministic split when the LLM fails', async () => {
    const complete = vi.fn(async () => {
      throw new Error('boom')
    }) as unknown as CompleteFn

    const r = await decomposeAndScheduleWeek({
      weekStart: WEEK,
      weekLabel: 'Complete system design',
      weeklyHours: 5,
      availability,
      provider: 'gemini',
      complete,
    })

    expect(r.days).toHaveLength(5)
    expect(r.days[0].title).toContain('step 1/5')
  })

  it('respects blocked dates (no work placed on a blocked day)', async () => {
    const complete = vi.fn(async () => ({
      object: { steps: [{ title: 'Do the thing', hours: 1 }] },
      meta: { mode: 'object' },
    })) as unknown as CompleteFn

    const r = await decomposeAndScheduleWeek({
      weekStart: WEEK,
      weekLabel: 'X',
      weeklyHours: 2,
      availability,
      blockedDates: ['2026-10-05'], // block Monday
      provider: 'gemini',
      complete,
    })
    expect(r.days).toHaveLength(1)
    expect(r.days[0].date).not.toBe('2026-10-05')
  })
})
