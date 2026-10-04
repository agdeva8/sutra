/**
 * GET / PATCH /api/sources/[id] — integration tests (Iteration 11).
 *
 * GET exposes the stored `text_excerpt` so the Sources tab can reopen a link
 * source in the exploration dialog; PATCH saves the user's edits back to the
 * excerpt AskPlanner reads.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockGuestToken: vi.fn(),
}))

vi.mock('@/lib/env', () => ({
  env: {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    AUTH_SECRET: 'test-secret-test-secret-test-secret-test-secret-32+chars',
    EMERGENT_LLM_KEY: 'sk-emergent-test',
    INTEGRATION_PROXY_URL: 'https://integrations.emergentagent.com',
  },
}))

vi.mock('@/lib/auth', () => ({ auth: mocks.mockAuth }))
vi.mock('@/lib/guest-token', () => ({ verifyGuestToken: mocks.mockGuestToken }))

const row = {
  id: 'src_link001',
  userId: 'user_founder01',
  goalId: null,
  goalTitle: '',
  kind: 'link',
  storagePath: '',
  originalFilename: 'https://example.com',
  contentType: 'text/uri-list',
  size: 0,
  url: 'https://example.com',
  textExcerpt: 'Design Uber. Design a rate limiter.',
  isDeleted: false,
  createdAt: new Date('2026-01-01T00:00:00Z'),
}

function makeSelectChain(rows: any[]) {
  const chain: any = {}
  chain.from = vi.fn(() => chain)
  chain.where = vi.fn(() => chain)
  chain.limit = vi.fn(() => Promise.resolve(rows))
  return chain
}

const capturedUpdate = vi.hoisted(() => ({ set: vi.fn() }))

vi.mock('@/lib/db', () => ({
  db: {
    select: vi.fn(() => makeSelectChain([])),
    update: vi.fn(() => ({
      set: (vals: any) => {
        capturedUpdate.set(vals)
        return { where: () => ({ returning: () => Promise.resolve([{ ...row, ...vals }]) }) }
      },
    })),
  },
}))

import { GET, PATCH } from '../route'
import { NextRequest } from 'next/server'

const { mockAuth, mockGuestToken } = mocks

const SESSION_TOKEN = 'test_session_founder01'

function req(method: string, id: string, body?: object, token?: string) {
  const headers = new Headers({ 'Content-Type': 'application/json' })
  if (token) headers.set('Authorization', `Bearer ${token}`)
  return new NextRequest(`http://localhost/api/sources/${id}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
}

const params = (id: string) => ({ params: Promise.resolve({ id }) })

describe('GET /api/sources/[id]', () => {
  beforeEach(async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user_founder01', isGuest: false, modelProvider: 'gemini' } })
    mockGuestToken.mockReturnValue(null)
    const { db } = await import('@/lib/db')
    ;(db as any).select = vi.fn(() => makeSelectChain([]))
  })
  afterEach(() => { vi.clearAllMocks() })

  it('rejects unauthenticated requests with 401', async () => {
    mockAuth.mockResolvedValueOnce({ user: null })
    const res = await GET(req('GET', 'src_x'), params('src_x'))
    expect(res.status).toBe(401)
  })

  it('returns 404 when not found/owned', async () => {
    const res = await GET(req('GET', 'src_none', undefined, SESSION_TOKEN), params('src_none'))
    expect(res.status).toBe(404)
  })

  it('returns the source with its text_excerpt', async () => {
    const { db } = await import('@/lib/db')
    ;(db as any).select = vi.fn(() => makeSelectChain([row]))
    const res = await GET(req('GET', 'src_link001', undefined, SESSION_TOKEN), params('src_link001'))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.id).toBe('src_link001')
    expect(data.text_excerpt).toBe('Design Uber. Design a rate limiter.')
  })
})

describe('PATCH /api/sources/[id]', () => {
  beforeEach(async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user_founder01', isGuest: false, modelProvider: 'gemini' } })
    mockGuestToken.mockReturnValue(null)
    capturedUpdate.set.mockClear()
    const { db } = await import('@/lib/db')
    ;(db as any).select = vi.fn(() => makeSelectChain([]))
  })
  afterEach(() => { vi.clearAllMocks() })

  it('rejects unauthenticated requests with 401', async () => {
    mockAuth.mockResolvedValueOnce({ user: null })
    const res = await PATCH(req('PATCH', 'src_x', { text_excerpt: 'x' }), params('src_x'))
    expect(res.status).toBe(401)
  })

  it('returns 400 when text_excerpt is missing', async () => {
    const res = await PATCH(req('PATCH', 'src_x', {}, SESSION_TOKEN), params('src_x'))
    expect(res.status).toBe(400)
  })

  it('returns 404 for a source the caller does not own', async () => {
    const res = await PATCH(
      req('PATCH', 'src_none', { text_excerpt: 'edited' }, SESSION_TOKEN),
      params('src_none'),
    )
    expect(res.status).toBe(404)
  })

  it('updates the stored excerpt and returns the row', async () => {
    const { db } = await import('@/lib/db')
    ;(db as any).select = vi.fn(() => makeSelectChain([{ id: 'src_link001' }]))
    const res = await PATCH(
      req('PATCH', 'src_link001', { text_excerpt: '  Edited content for the plan  ' }, SESSION_TOKEN),
      params('src_link001'),
    )
    expect(res.status).toBe(200)
    // The excerpt is trimmed before persisting.
    expect(capturedUpdate.set).toHaveBeenCalledWith({ textExcerpt: 'Edited content for the plan' })
    expect((await res.json()).text_excerpt).toBe('Edited content for the plan')
  })
})