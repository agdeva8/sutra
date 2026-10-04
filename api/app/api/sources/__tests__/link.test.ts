/**
 * Sources link endpoint — integration tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockGuestToken: vi.fn(),
  mockFetchLinkText: vi.fn(),
  mockDbInsertReturning: vi.fn(),
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
vi.mock('@/lib/sources', () => ({ fetchLinkText: mocks.mockFetchLinkText, extractText: vi.fn() }))
vi.mock('@/lib/db', () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn((vals: any) => ({
        returning: vi.fn(() => Promise.resolve([{
          id: 'src_link001',
          userId: vals?.userId ?? null,
          goalId: vals?.goalId ?? null,
          goalTitle: vals?.goalTitle ?? '',
          kind: vals?.kind ?? 'link',
          storagePath: vals?.storagePath ?? '',
          originalFilename: vals?.originalFilename ?? '',
          contentType: vals?.contentType ?? '',
          size: vals?.size ?? 0,
          url: vals?.url ?? '',
          textExcerpt: vals?.textExcerpt ?? '',
          isDeleted: vals?.isDeleted ?? false,
          createdAt: new Date('2026-01-01T00:00:00Z'),
        }])),
      })),
    })),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
        orderBy: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    }),
  },
}))

import { POST } from '../link/route'
import { NextRequest } from 'next/server'

const { mockAuth, mockGuestToken, mockFetchLinkText, mockDbInsertReturning } = mocks

const SESSION_TOKEN = 'test_session_founder01'

function makePostRequest(body: object, token?: string) {
  const headers = new Headers({ 'Content-Type': 'application/json' })
  if (token) headers.set('Authorization', `Bearer ${token}`)
  return new NextRequest('http://localhost/api/sources/link', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

describe('POST /api/sources/link', () => {
  beforeEach(() => {
    mockAuth.mockResolvedValue({
      user: { id: 'user_founder01', isGuest: false, modelProvider: 'gemini' },
    })
    mockGuestToken.mockReturnValue(null)
    mockFetchLinkText.mockResolvedValue('[fetched link text]')
    mockDbInsertReturning.mockResolvedValue([{
      id: 'src_link001',
      userId: 'user_founder01',
      goalId: null,
      goalTitle: '',
      kind: 'link',
      storagePath: '',
      originalFilename: 'https://example.com/article',
      contentType: 'text/uri-list',
      size: 0,
      url: 'https://example.com/article',
      textExcerpt: '[fetched link text]',
      isDeleted: false,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    }])
  })
  afterEach(() => { vi.clearAllMocks() })

  it('rejects unauthenticated requests with 401', async () => {
    mockAuth.mockResolvedValueOnce({ user: null })
    const res = await POST(makePostRequest({ url: 'https://example.com' }))
    expect(res.status).toBe(401)
  })

  it('returns 400 when url is missing', async () => {
    const res = await POST(makePostRequest({}, SESSION_TOKEN))
    expect(res.status).toBe(400)
  })

  it('returns 400 for an invalid URL', async () => {
    const res = await POST(makePostRequest({ url: 'not-a-url' }, SESSION_TOKEN))
    expect(res.status).toBe(400)
    expect((await res.json()).detail).toMatch(/invalid url/i)
  })

  it('creates a link record and returns it', async () => {
    const res = await POST(
      makePostRequest({ url: 'https://example.com/article', title: 'Example Article' }, SESSION_TOKEN),
    )
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.kind).toBe('link')
    expect(data.url).toBe('https://example.com/article')
    expect(data.original_filename).toBe('Example Article')
    expect(data.id).toMatch(/^src_/)
    expect(mockFetchLinkText).toHaveBeenCalledWith('https://example.com/article')
  })

  it('uses URL as title when title is absent', async () => {
    const res = await POST(makePostRequest({ url: 'https://example.com/page' }, SESSION_TOKEN))
    expect((await res.json()).original_filename).toBe('https://example.com/page')
  })

  it('stores pasted/curated text as the excerpt instead of re-fetching (Iteration 11)', async () => {
    const res = await POST(
      makePostRequest({ url: 'https://example.com/gated', text: 'Design Uber. Design a rate limiter.' }, SESSION_TOKEN),
    )
    expect(res.status).toBe(200)
    // Curated text supplied → the raw network fetch must NOT fire.
    expect(mockFetchLinkText).not.toHaveBeenCalled()
  })

  it('rejects goal_id that does not belong to the caller', async () => {
    // The mock for `db.select(...).from(goals)` returns [] by default
    // (see vi.mock above), so the goal lookup fails and the route
    // returns 404 'Goal not found' — the security fix for goal
    // ownership: any caller must NOT be able to attach their source
    // to another user's goal by guessing its id.
    const res = await POST(
      makePostRequest({ url: 'https://example.com/doc', goal_id: 'goal_not_mine' }, SESSION_TOKEN),
    )
    expect(res.status).toBe(404)
    expect((await res.json()).detail).toMatch(/goal not found/i)
  })
})