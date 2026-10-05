import { describe, expect, it } from 'vitest'

import { intakePrompt } from '../prompts'

const base = {
  intent: 'add_goal' as const,
  mode: 'ask' as const,
  message: 'I want to switch jobs in 3 months',
  context: '',
  today: '2026-10-05',
}

describe('intakePrompt — availability is asked once', () => {
  it('asks the availability questions when the user has none yet (first goal)', () => {
    const p = intakePrompt({ ...base, availabilityKnown: false })
    expect(p).toContain('AVAILABILITY (first goal')
    expect(p).toContain('Which days can you realistically put time into goals')
  })

  it('does NOT ask availability once it is known (later goals)', () => {
    const p = intakePrompt({ ...base, availabilityKnown: true })
    expect(p).not.toContain('AVAILABILITY (first goal')
    expect(p).toContain('already known')
  })
})
