import { describe, expect, it } from 'vitest'

import { daysBetween } from '../config'
import {
  buildLattice,
  BUFFER_RATIO,
  effectiveWindow,
  type SchedulerInput,
} from '../scheduler'

function input(over: Partial<SchedulerInput> = {}): SchedulerInput {
  return {
    today: '2026-10-04',
    goal_title: 'Switch jobs in 3 months',
    start_date: '2026-10-04',
    target_date: '2027-01-04',
    weekly_hours: 6,
    phases: [
      { name: 'Foundations', objective: 'Pass 5 system-design mocks' },
      { name: 'Mocks', objective: 'Crash 10 full interview loops' },
      { name: 'Active', objective: 'Land a senior-SDE offer' },
    ],
    milestones: [
      { title: 'Finish SD fundamentals', phase: 'Foundations', rationale: 'prereq' },
      { title: 'Pass 5 SD mocks', phase: 'Mocks', rationale: 'baseline' },
      { title: 'First 3 full loops', phase: 'Active', rationale: 'reps' },
      { title: 'Offer signed', phase: 'Active', rationale: 'target' },
    ],
    ...over,
  }
}

describe('buildLattice (deterministic scheduler)', () => {
  it('partitions [start, target] into contiguous, ordered phase spans', () => {
    const r = buildLattice(input())
    expect(r.spans).toHaveLength(3)
    expect(r.spans[0].start_date).toBe('2026-10-04')
    expect(r.spans[2].end_date).toBe('2027-01-04')
    for (let i = 1; i < r.spans.length; i++) {
      // Contiguous partition: a phase starts at or after the previous end.
      expect(r.spans[i].start_date >= r.spans[i - 1].end_date).toBe(true)
      expect(r.spans[i].start_date > r.spans[i - 1].start_date).toBe(true)
    }
  })

  it('keeps every milestone inside its phase effective (80%) window', () => {
    const r = buildLattice(input())
    const byMilestone = new Map(r.milestones.map((m) => [m.title, m]))
    for (const span of r.spans) {
      const winEnd = effectiveWindow(span.start_date, span.end_date)
      for (const m of r.milestones.filter((m) => m.phase === span.name)) {
        // 20% buffer: milestone due at or before span start + 0.8 × span.
        const dueDaysFromStart = daysBetween(span.start_date, m.target_date)
        const spanDays = daysBetween(span.start_date, span.end_date)
        expect(dueDaysFromStart).toBeLessThanOrEqual(Math.round(spanDays * (1 - BUFFER_RATIO)) + 1)
        expect(m.target_date <= winEnd).toBe(true)
        void byMilestone
      }
    }
  })

  it('emits weekly checkpoints across each phase effective window only', () => {
    const r = buildLattice(input())
    const weeklies = r.items.filter((i) => i.horizon === 'weekly')
    expect(weeklies.length).toBeGreaterThan(0)
    for (const w of weeklies) {
      // A weekly row must never cross into its phase's 20% tail buffer.
      const span = r.spans.find((s) => s.name === w.phase)!
      const winEnd = effectiveWindow(span.start_date, span.end_date)
      expect(w.start_date! <= winEnd).toBe(true)
      expect(w.start_date! <= w.end_date!).toBe(true)
    }
    // The very last weekly row should end at (or just before) the window end.
    const lastWeekly = weeklies[weeklies.length - 1]
    const lastPhase = r.spans[r.spans.length - 1]
    const lastWinEnd = effectiveWindow(lastPhase.start_date, lastPhase.end_date)
    expect(lastWeekly.end_date! <= lastWinEnd).toBe(true)
  })

  it('flags weekly rows with the upcoming milestone title (readable labels)', () => {
    const r = buildLattice(input())
    const firstWeekly = r.items.find((i) => i.horizon === 'weekly')!
    expect(firstWeekly.title).toMatch(/Week 1 — /)
    expect(firstWeekly.title.length).toBeGreaterThan('Week 1 — '.length)
  })

  it('emits one plan task per calendar day, each fulfilling the week milestone', () => {
    const r = buildLattice(input())
    const tasks = r.items.filter(
      (i) => i.horizon === 'daily' && i.note.startsWith('Fulfils'),
    )
    expect(tasks.length).toBeGreaterThan(0)
    for (const t of tasks) {
      expect(t.note).toMatch(/h$/)
      expect(t.due_date).toBe(t.start_date)
    }
    // Every daily row is a plan task (no commitment rows any more).
    const nonFulfils = r.items.filter(
      (i) => i.horizon === 'daily' && !i.note.startsWith('Fulfils'),
    )
    expect(nonFulfils).toHaveLength(0)
  })

  it('emits one yearly row (the goal span) and quarterly rows per phase', () => {
    const r = buildLattice(input())
    const yearly = r.items.filter((i) => i.horizon === 'yearly')
    const quarters = r.items.filter((i) => i.horizon === 'quarterly')
    expect(yearly).toHaveLength(1)
    expect(yearly[0].title).toBe('Switch jobs in 3 months')
    expect(yearly[0].start_date).toBe('2026-10-04')
    expect(yearly[0].end_date).toBe('2027-01-04')
    expect(quarters).toHaveLength(3)
  })

  it('returns milestone dates in the same order as the input milestones', () => {
    const r = buildLattice(input())
    expect(r.milestones.map((m) => m.title)).toEqual([
      'Finish SD fundamentals',
      'Pass 5 SD mocks',
      'First 3 full loops',
      'Offer signed',
    ])
    for (const m of r.milestones) {
      expect(m.target_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  it('handles a near-zero horizon gracefully (clamps to 7 days)', () => {
    const r = buildLattice(input({ target_date: '2026-10-05' }))
    expect(r.spans.length).toBe(3)
    expect(r.spans[2].end_date >= r.spans[2].start_date).toBe(true)
    expect(r.items.some((i) => i.horizon === 'yearly')).toBe(true)
  })

  it('handles a plan with no phases (falls back to one unnamed span)', () => {
    const r = buildLattice(input({ phases: [] }))
    expect(r.spans).toHaveLength(1)
    expect(r.items.filter((i) => i.horizon === 'quarterly')).toHaveLength(0)
    // Milestones still get dated (fallback to span start at worst).
    expect(r.milestones).toHaveLength(4)
  })

  it('is deterministic across identical inputs', () => {
    const a = buildLattice(input())
    const b = buildLattice(input())
    expect(a.items).toEqual(b.items)
    expect(a.milestones).toEqual(b.milestones)
  })
})

describe('buildLattice — distinct parts + parallel workstreams', () => {
  const twoMilestones = () =>
    input({
      phases: [{ name: 'Foundations', objective: 'Ship the foundation' }],
      milestones: [
        { title: 'Target list of 20 companies', phase: 'Foundations', rationale: 'a' },
        { title: 'System design: 6 core topics', phase: 'Foundations', rationale: 'b' },
      ],
      start_date: '2026-01-01',
      target_date: '2026-03-01',
      weekly_hours: 20,
    })

  it('labels weeks with distinct parts of a milestone, not its name alone', () => {
    const r = buildLattice(twoMilestones())
    const weeklies = r.items.filter((i) => i.horizon === 'weekly')
    expect(weeklies.length).toBeGreaterThan(0)
    // A part index is only allowed when the window spans >1 week; a single-week
    // window must NOT read "— part 1/1".
    for (const wk of weeklies) {
      const m = wk.title.match(/part (\d+)\/(\d+)/)
      if (m) expect(Number(m[2])).toBeGreaterThan(1)
    }
    // Consecutive weeks for the SAME milestone are distinct strings.
    const partsOf = (name: string) =>
      weeklies.filter((w) => w.title.includes(name)).map((w) => w.title)
    const a = partsOf('Target list of 20 companies')
    expect(new Set(a).size).toBe(a.length)
  })

  it('runs milestones in parallel — some week carries two workstreams', () => {
    const r = buildLattice(twoMilestones())
    const weeklies = r.items.filter((i) => i.horizon === 'weekly')
    const perWeek = new Map<string, number>()
    for (const w of weeklies) perWeek.set(w.start_date!, (perWeek.get(w.start_date!) ?? 0) + 1)
    expect([...perWeek.values()].some((n) => n >= 2)).toBe(true)
  })
})