/**
 * State route — cache regression test.
 *
 * The single most important guarantee the founder asked for is "don't
 * show stale data after a write". This file pins that invariant at the
 * route layer: the SECOND GET /api/state after a mutation must reflect
 * the mutation, even if the cache had been pre-warmed with the old data.
 *
 * A second invariant — the read cache actually accelerates the hot path —
 * is exercised by the same mock: a cache hit on the second identical GET
 * never reaches the DB.
 *
 * Mock design: every `db.select()` builds a chain whose `.from()` is
 * resolved by TABLE IDENTITY, not by call order, so the cache can
 * parallelise the underlying queries (lib/llm/state-builder.ts uses
 * Promise.all) without breaking the mock.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

import {
  auditLog,
  blockers,
  commitments,
  goals,
  milestones,
  planItems,
  sources,
  timetableBlocks,
  users,
} from '@/db/schema'
import {
  clearCache,
  cacheStats,
  invalidateUser,
} from '@/lib/cache'

/* -------------------------------------------------------------------------- */
/* Mocks — declared before importing the route so vi.mock hooks land first.   */
/* -------------------------------------------------------------------------- */

const mocks = vi.hoisted(() => {
  const mockAuth = vi.fn()
  const results = {
    goals: [] as unknown[],
    commitments: [] as unknown[],
    milestones: [] as unknown[],
    blockers: [] as unknown[],
    sources: [] as unknown[],
    planItems: [] as unknown[],
    audit: [] as unknown[],
    users: [] as unknown[],
    timetableBlocks: [] as unknown[],
  }

  function buildChain(tableName: keyof typeof results): any {
    const chain: any = {}
    chain.from = vi.fn((t: unknown) => {
      // Resolve `.from(<table>)` by reference equality against the real
      // schema objects imported above. This is what makes the mock
      // order-independent — Promise.all can fire the queries in any
      // order, and we still route each one to its own fixture.
      const tableByName = {
        goals,
        commitments,
        milestones,
        blockers,
        sources,
        planItems,
        auditLog,
        users,
        timetableBlocks,
      } as Record<string, unknown>
      for (const [name, table] of Object.entries(tableByName)) {
        if (table === t) return results[name as keyof typeof results].length === 0
          ? buildChain(name as keyof typeof results) // unknown, fall through
          : (() => {
              const c = buildChain(name as keyof typeof results)
              return c
            })()
      }
      throw new Error(`unknown table: ${String(t)}`)
    })
    chain.where = vi.fn(() => chain)
    chain.orderBy = vi.fn(() => chain)
    chain.limit = vi.fn(() =>
      Promise.resolve(results[tableName] as unknown[]),
    )
    return chain
  }

  // Per-table chain objects (shared identity for identity-based dispatch).
  const chains = {
    goals: buildChain('goals'),
    commitments: buildChain('commitments'),
    milestones: buildChain('milestones'),
    blockers: buildChain('blockers'),
    sources: buildChain('sources'),
    planItems: buildChain('planItems'),
    audit: buildChain('audit'),
    users: buildChain('users'),
    timetableBlocks: buildChain('timetableBlocks'),
  }

  let selectCallCount = 0
  const dbMock = {
    select: vi.fn(() => {
      selectCallCount++
      // Return an object whose `.from()` dispatches by table identity.
      const stub: any = {}
      stub.from = vi.fn((t: unknown) => {
        if (t === goals) return chains.goals
        if (t === commitments) return chains.commitments
        if (t === milestones) return chains.milestones
        if (t === blockers) return chains.blockers
        if (t === sources) return chains.sources
        if (t === planItems) return chains.planItems
        if (t === auditLog) return chains.audit
        if (t === users) return chains.users
        if (t === timetableBlocks) return chains.timetableBlocks
        throw new Error(`unknown table: ${String(t)}`)
      })
      stub.where = vi.fn(() => stub)
      stub.orderBy = vi.fn(() => stub)
      stub.limit = vi.fn(() => Promise.resolve([]))
      return stub
    }),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
    _selectCallCount: () => selectCallCount,
    _reset: () => {
      selectCallCount = 0
    },
  }

  return { mockAuth, dbMock, results, chains }
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

vi.mock('@/lib/auth', () => ({
  auth: () => mocks.mockAuth(),
  getAuthenticatedUser: () =>
    mocks.mockAuth().then((s: any) =>
      s
        ? {
            user: {
              id: s.user.id,
              email: null,
              name: null,
              image: null,
              modelProvider: 'gemini',
              isGuest: false,
            },
            source: 'session',
          }
        : null,
    ),
}))
vi.mock('@/lib/db', () => ({ db: mocks.dbMock }))
vi.mock('@/lib/drift-service', () => ({
  recomputeGoalDrift: vi.fn().mockResolvedValue([]),
}))

// Imported AFTER mocks so the route sees the mocked db.
import { GET } from '../route'

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

const USER = 'user_cache_test'

function authedRequest() {
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${USER}`)
  return new NextRequest('http://localhost/api/state', { headers })
}

function setGoal(id: string, title: string) {
  mocks.results.goals = [{ id, title, horizon: 'long', status: 'active' }]
}
function clearGoals() {
  mocks.results.goals = []
}

beforeEach(() => {
  mocks.mockAuth.mockResolvedValue({
    user: { id: USER, isGuest: false, modelProvider: 'gemini' },
  })
  clearCache()
  mocks.dbMock._reset()
  // All other fixtures empty by default
  mocks.results.commitments = []
  mocks.results.milestones = []
  mocks.results.blockers = []
  mocks.results.sources = []
  mocks.results.planItems = []
  mocks.results.audit = []
})

/* -------------------------------------------------------------------------- */
/* Tests                                                                    */
/* -------------------------------------------------------------------------- */

describe('GET /api/state — write-through cache contract', () => {
  it('the second identical GET is served from cache (zero DB hits)', async () => {
    setGoal('g1', 'Read 12 books')

    const r1 = await GET(authedRequest())
    expect(r1.status).toBe(200)
    const callsAfterFirst = mocks.dbMock._selectCallCount()
    expect(callsAfterFirst).toBeGreaterThan(0) // first GET did load

    const r2 = await GET(authedRequest())
    expect(r2.status).toBe(200)
    expect(mocks.dbMock._selectCallCount()).toBe(callsAfterFirst) // zero new selects

    const stats = cacheStats()
    expect(stats.hits).toBe(1)
  })

  it('a mutation invalidates the cache so the next GET reloads fresh data', async () => {
    setGoal('g1', 'Read 12 books')
    const r1 = await GET(authedRequest())
    const goals1 = (await r1.json()).goals
    expect(goals1).toHaveLength(1)

    // Simulate the auth-choke-point invalidation that any mutating
    // request would trigger before doing its writes.
    invalidateUser(USER)

    // And the mutation changed the underlying data.
    setGoal('g1', 'Read 24 books')
    mocks.results.commitments = [
      { id: 'c1', text: 'Pick 6', status: 'open' },
    ]

    const r2 = await GET(authedRequest())
    const body2 = await r2.json()
    expect(body2.goals[0].title).toBe('Read 24 books')
    expect(body2.commitments).toHaveLength(1)
  })

  it('explicit write-through refresh leaves the cache serving fresh data', async () => {
    setGoal('g1', 'old title')
    await GET(authedRequest())
    // Mutation already happened on another instance; we simulate the
    // refresh that runs after a state-affecting mutation on this one.
    invalidateUser(USER)
    setGoal('g1', 'new title')

    // scheduleWriteThroughRefresh normally fires via `after()`; here we
    // drive the refresh directly, which is what it eventually calls.
    const { refreshDashboardState } = await import('@/lib/dashboard-state')
    const refreshed = await refreshDashboardState(USER)
    expect(refreshed).not.toBeNull()
    expect(refreshed!.goals[0].title).toBe('new title')

    // Next GET is a cache hit AND carries the new title.
    const r = await GET(authedRequest())
    const body = await r.json()
    expect(body.goals[0].title).toBe('new title')
  })

  it('a failing refresh leaves the cache cold (next read still gets fresh data)', async () => {
    setGoal('g1', 'first version')
    await GET(authedRequest())
    clearCache() // simulate invalidate before refresh
    mocks.dbMock.select.mockImplementationOnce(() => {
      throw new Error('transient db error')
    })

    const { refreshDashboardState } = await import('@/lib/dashboard-state')
    const refreshed = await refreshDashboardState(USER)
    expect(refreshed).toBeNull()

    // The cache must be COLD (not stale) — verify by reading directly
    // and confirming the loader runs again on the next hit.
    mocks.dbMock.select.mockImplementation(() => {
      const stub: any = {}
      stub.from = vi.fn(() => stub)
      stub.where = vi.fn(() => stub)
      stub.orderBy = vi.fn(() => stub)
      stub.limit = vi.fn(() => Promise.resolve(mocks.results.goals))
      return stub
    })
    clearGoals()
    setGoal('g1', 'after-failure')
    const r = await GET(authedRequest())
    const body = await r.json()
    expect(body.goals[0].title).toBe('after-failure')
  })
})
