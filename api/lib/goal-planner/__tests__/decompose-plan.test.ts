import { describe, expect, it, vi } from 'vitest'

import { buildLattice } from '../scheduler'
import { decomposePlanItems } from '../decompose'
import type { CompleteFn } from '../orchestrator'

const availability = { mon: 2, tue: 2, wed: 2, thu: 2, fri: 2, sat: 0, sun: 0 }

function lattice() {
  return buildLattice({
    today: '2026-10-05',
    goal_title: 'Switch jobs',
    start_date: '2026-10-05',
    target_date: '2026-11-30',
    weekly_hours: 4,
    phases: [
      { name: 'Foundations', objective: 'x' },
      { name: 'Active', objective: 'y' },
    ],
    milestones: [
      { title: 'M1', phase: 'Foundations', rationale: '' },
      { title: 'M2', phase: 'Active', rationale: '' },
    ],
  }).items
}

describe('decomposePlanItems (plan-wide OR-Tools placement)', () => {
  it('places daily work on available weekdays and keeps the lattice structure', async () => {
    const complete = vi.fn(async () => ({
      object: { steps: [{ title: 'Read ch 1', hours: 1 }, { title: 'Do exercise', hours: 1 }] },
      meta: { mode: 'object' },
    })) as unknown as CompleteFn

    const out = await decomposePlanItems(lattice(), { availability, provider: 'gemini', complete })

    expect(out.filter((r) => r.horizon === 'yearly')).toHaveLength(1)
    expect(out.filter((r) => r.horizon === 'weekly').length).toBeGreaterThan(0)

    const dailies = out.filter((r) => r.horizon === 'daily')
    expect(dailies.length).toBeGreaterThan(0)
    for (const d of dailies) {
      expect(d.note.startsWith('Fulfils')).toBe(true)
      const wd = new Date((d.start_date as string) + 'T00:00:00.000Z').getUTCDay()
      expect(wd === 0 || wd === 6).toBe(false)
    }
  })

  it('returns the input unchanged when availability is unset', async () => {
    const rows = lattice()
    const out = await decomposePlanItems(rows, {
      availability: {},
      provider: 'gemini',
      complete: vi.fn() as unknown as CompleteFn,
    })
    expect(out).toBe(rows)
  })
})
