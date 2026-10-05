/**
 * over-commitment.ts — pure-function tests.
 *
 * The heuristic lives in `lib/over-commitment.ts` and is the single
 * source of truth for the dashboard chip and the chat-time context
 * string. These tests pin the level thresholds so a tweak to the
 * levels is forced to update the corresponding dashboard UI.
 *
 * Commitments were removed from the product, so the heuristic is now
 * goals-only.
 */

import { describe, it, expect } from 'vitest'

import {
  computeOverCommitment,
  levelColor,
  type OverCommitmentGoal,
} from '@/lib/over-commitment'

const ACTIVE = (n: number): OverCommitmentGoal[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `g${i}`,
    title: `Goal ${i + 1}`,
    status: 'active',
  }))

describe('computeOverCommitment', () => {
  it('clear with no goals', () => {
    const r = computeOverCommitment([])
    expect(r.level).toBe('clear')
    expect(r.active_goals).toBe(0)
    expect(r.conflicting).toEqual([])
    expect(r.message).toMatch(/steady/i)
  })

  it('moderate at 3 active goals', () => {
    const r = computeOverCommitment(ACTIVE(3))
    expect(r.level).toBe('moderate')
    expect(r.active_goals).toBe(3)
    expect(r.message).toMatch(/3 goals in play/)
  })

  it('high at 5 active goals (with conflicting list of top 3)', () => {
    const r = computeOverCommitment(ACTIVE(5))
    expect(r.level).toBe('high')
    expect(r.active_goals).toBe(5)
    expect(r.conflicting).toEqual(['Goal 1', 'Goal 2', 'Goal 3'])
  })

  it('critical at 7+ active goals', () => {
    const r = computeOverCommitment(ACTIVE(8))
    expect(r.level).toBe('critical')
    expect(r.active_goals).toBe(8)
    expect(r.conflicting.length).toBe(3)
    expect(r.message).toMatch(/wish-list/)
  })

  it('dropped goals do not count', () => {
    const goals: OverCommitmentGoal[] = [
      ...ACTIVE(7),
      { id: 'd1', title: 'Dropped', status: 'dropped' },
    ]
    const r = computeOverCommitment(goals)
    expect(r.level).toBe('critical')
    expect(r.active_goals).toBe(7)
    // dropped goals shouldn't appear in conflicting
    expect(r.conflicting).not.toContain('Dropped')
  })

  it('paused goals do not count', () => {
    const goals: OverCommitmentGoal[] = Array.from({ length: 7 }, (_, i) => ({
      id: `p${i}`,
      title: `Paused ${i}`,
      status: 'paused',
    }))
    const r = computeOverCommitment(goals)
    expect(r.active_goals).toBe(0)
    expect(r.level).toBe('clear')
  })
})

describe('levelColor', () => {
  it('returns a palette object for every level', () => {
    for (const lvl of ['clear', 'moderate', 'high', 'critical'] as const) {
      const c = levelColor(lvl)
      expect(c.bg).toMatch(/^bg-/)
      expect(c.text).toMatch(/^text-/)
      expect(c.border).toMatch(/^border-/)
      expect(c.dot).toMatch(/^bg-/)
    }
  })

  it('returns distinct colors per level (no two levels share a dot color)', () => {
    const dots = new Set(
      ['clear', 'moderate', 'high', 'critical'].map((l) => levelColor(l as any).dot),
    )
    expect(dots.size).toBe(4)
  })
})
