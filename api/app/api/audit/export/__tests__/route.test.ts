/**
 * Tests for GET /api/audit/export (JSON file dump).
 *
 * Approach: spy on Promise.all so we can intercept the parallel select calls
 * without dealing with query-chain mocking complexities.
 */

vi.mock('@/lib/env', () => ({
  env: {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    AUTH_SECRET: 'test-secret-test-secret-test-secret-test-secret-32+chars',
    EMERGENT_LLM_KEY: 'sk-emergent-test',
    INTEGRATION_PROXY_URL: 'https://integrations.emergentagent.com',
  },
}))

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

import { GUEST_TOKEN_COOKIE, signGuestToken } from '@/lib/guest-token'

/* -------------------------------------------------------------------------- */
/* Mocks                                                                      */
/* -------------------------------------------------------------------------- */

const mockAuth = vi.fn().mockResolvedValue(null)
vi.mock('@/lib/auth', () => ({
  auth: () => mockAuth(),
}))

function makeChain(rows: unknown[]): Record<string, unknown> {
  const chain: Record<string, unknown> = {}
  chain.from = vi.fn(() => chain)
  chain.where = vi.fn(() => chain)
  chain.orderBy = vi.fn(() => chain)
  chain.limit = vi.fn(() => Promise.resolve(rows))
  return chain
}

// Module-level queue that survives vi.restoreAllMocks().
const selectQueue: Array<() => unknown> = []

vi.mock('@/lib/db', () => ({
  db: {
    select: vi.fn(() => {
      const fn = selectQueue.shift()
      return fn ? fn() : makeChain([])
    }),
  },
}))

function makeRequest(cookieValue: string | null = null): NextRequest {
  const headers: Record<string, string> = {}
  if (cookieValue) headers.cookie = `${GUEST_TOKEN_COOKIE}=${cookieValue}`
  return new NextRequest('http://localhost/api/audit/export', { headers })
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe('GET /api/audit/export', () => {
  beforeEach(() => {
    mockAuth.mockReset()
    mockAuth.mockResolvedValue(null)
    selectQueue.length = 0
  })

  afterEach(() => {
    mockAuth.mockReset()
  })

  it('returns 401 when not authenticated', async () => {
    const { GET } = await import('@/app/api/audit/export/route')
    const res = await GET(makeRequest(null))
    expect(res.status).toBe(401)
  })

  it('returns a JSON body when authenticated via guest_token', async () => {
    const userId = 'user_abc123'
    const { token } = signGuestToken(userId)

    // User lookup chain.
    selectQueue.push(() => makeChain([{ id: userId, email: 'test@example.com', name: 'Test User' }]))

    // Spy on global Promise.all to intercept the parallel data selects.
    const originalPromiseAll = Promise.all.bind(Promise)
    vi.spyOn(Promise, 'all').mockImplementationOnce((iterable) => {
      const arr = Array.from(iterable as Iterable<Promise<unknown>>)
      // Each parallel select resolves to an array of rows — produce
      // matching arrays so the route's `rows.map(...)` works.
      return originalPromiseAll(
        arr.map(() =>
          Promise.resolve([
            {
              id: 'audit_001',
              userId,
              type: 'confirm:create_goal',
              summary: 'Created goal',
              payload: {},
              createdAt: new Date('2026-01-01T10:00:00Z'),
            },
          ])
        )
      )
    })

    const { GET } = await import('@/app/api/audit/export/route')
    const res = await GET(makeRequest(token))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('audit_log')
    expect(body).toHaveProperty('conversation')
    expect(body).toHaveProperty('state')
    expect(body.state).toHaveProperty('goals')
    expect(body.user.email).toBe('test@example.com')
  })

  it('sets Content-Disposition header for file download', async () => {
    const userId = 'user_abc123'
    const { token } = signGuestToken(userId)

    selectQueue.push(() => makeChain([{ id: userId, email: null, name: null }]))

    const originalPromiseAll = Promise.all.bind(Promise)
    vi.spyOn(Promise, 'all').mockImplementationOnce((iterable) => {
      const arr = Array.from(iterable as Iterable<Promise<unknown>>)
      return originalPromiseAll(arr.map(() => Promise.resolve([])))
    })

    const { GET } = await import('@/app/api/audit/export/route')
    const res = await GET(makeRequest(token))
    expect(res.status).toBe(200)
    const disposition = res.headers.get('Content-Disposition')
    expect(disposition).toMatch(/attachment/)
    expect(disposition).toMatch(/sutra-export-/)
    expect(disposition).toMatch(/\.json/)
  })
})