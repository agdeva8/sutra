/**
 * State tests — ported from backend_test.py TestState.
 * Tests: state shape with goals, commitments, over_commitment.
 *
 * The route now hits the real Drizzle DB via `loadState`. We mock
 * the DB at the test boundary so the test runs without Postgres.
 */

import { describe, it, expect, vi } from 'vitest'
import { GET } from '../route'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => {
  const mockAuth = vi.fn()
  const goalsChain: any = {}
  const commitsChain: any = {}
  const mileChain: any = {}
  const blockChain: any = {}
  const sourcesChain: any = {}
  const auditChain: any = {}
  const userChain: any = {}
  const timetableChain: any = {}

  // Each table has its own chain with a stable result for `.limit()`.
  function buildChain(result: unknown[]): any {
    const c: any = {}
    c.from = vi.fn(() => c)
    c.where = vi.fn(() => c)
    c.orderBy = vi.fn(() => c)
    c.limit = vi.fn(() => Promise.resolve(result))
    return c
  }

  const goalsRows = [
    {
      id: 'goal_1',
      title: 'Read 12 books',
      horizon: 'long',
      status: 'active',
      nextAction: 'pick the first 3',
      targetDate: '2026-12-31',
    },
  ]
  const commitRows = [
    {
      id: 'commit_1',
      text: 'Pick the first 3 books',
      status: 'open',
      due: null,
      goalTitle: 'Read 12 books',
    },
  ]
  const mileRows = [
    {
      id: 'mile_1',
      title: 'First 3 books read',
      targetDate: '2026-09-30',
      goalTitle: 'Read 12 books',
      status: 'open',
    },
  ]
  const blockRows: any[] = []
  const sourceRows: any[] = []
  const auditRows = [
    {
      id: 'audit_1',
      type: 'create:goal',
      summary: "Created goal 'Read 12 books'",
      createdAt: new Date('2026-09-24T00:00:00Z'),
    },
  ]
  const userRows = [{ availableWeeklyHours: 40 }]
  const timetableRows: any[] = []

  const cGoals = buildChain(goalsRows)
  const cCommits = buildChain(commitRows)
  const cMiles = buildChain(mileRows)
  const cBlocks = buildChain(blockRows)
  const cSources = buildChain(sourceRows)
  const cAudit = buildChain(auditRows)
  const cUsers = buildChain(userRows)
  const cTimetable = buildChain(timetableRows)

  const dbMock = {
    select: vi.fn(() => {
      // We discriminate on the order in which `.from()` is called.
      // The route loads goals, commitments, milestones, blockers,
      // sources, audit summary, user capacity, timetable blocks. We rotate
      // through the prepared chains in lockstep.
      const queue = [cGoals, cCommits, cMiles, cBlocks, cSources, cAudit, cUsers, cTimetable]
      const out: any = {}
      out.from = vi.fn(() => {
        const pick = queue.shift()
        return pick ?? cGoals
      })
      return out
    }),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  }
  void goalsChain
  void commitsChain
  void mileChain
  void blockChain
  void sourcesChain
  void auditChain
  void userChain
  void timetableChain

  return { mockAuth, dbMock }
})

vi.mock('@/lib/env', () => ({
  env: {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    AUTH_SECRET:
      'test-secret-test-secret-test-secret-test-secret-32+chars',
    GOOGLE_CLIENT_ID: 'test-google-client-id',
    GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
    GOOGLE_GENERATIVE_AI_API_KEY: 'test-google-key',
    ANTHROPIC_API_KEY: 'test-anthropic-key',
    OPENAI_API_KEY: 'test-openai-key',
    MINIMAX_API_KEY: 'test-MiniMax-key',
    MINIMAX_BASE_URL: 'https://api.minimax.example.com',
    BLOB_READ_WRITE_TOKEN: 'test-blob-token',
  },
}))

vi.mock('@/lib/auth', () => ({ auth: () => mocks.mockAuth(), getAuthenticatedUser: () => mocks.mockAuth().then((s: any) => s ? { user: { id: s.user.id, email: null, name: null, image: null, modelProvider: 'gemini', isGuest: false }, source: 'session' } : null) }))
vi.mock('@/lib/db', () => ({ db: mocks.dbMock }))
vi.mock('@/lib/drift-service', () => ({
  recomputeGoalDrift: vi.fn().mockResolvedValue([]),
}))

const SESSION_TOKEN = 'test_session_founder01'

function makeRequest() {
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${SESSION_TOKEN}`)
  return new NextRequest('http://localhost/api/state', { headers })
}

describe('TestState', () => {
  it('test_state_shape', async () => {
    mocks.mockAuth.mockResolvedValue({
      user: { id: SESSION_TOKEN, isGuest: false, modelProvider: 'gemini' },
    })
    const req = makeRequest()
    const res = await GET(req)
    expect(res.status).toBe(200)
    const d = await res.json()
    expect(d).toHaveProperty('goals')
    expect(d).toHaveProperty('over_commitment')
    const oc = d.over_commitment
    expect(oc).toHaveProperty('level')
    expect(['clear', 'moderate', 'high', 'critical']).toContain(oc.level)
    expect(typeof oc.active_goals).toBe('number')
  })

  it('returns 401 when not authenticated', async () => {
    mocks.mockAuth.mockResolvedValue(null)
    const headers = new Headers()
    const req = new NextRequest('http://localhost/api/state', { headers })
    const res = await GET(req)
    expect(res.status).toBe(401)
  })
})
