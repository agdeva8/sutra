/**
 * POST /api/sources/link/extract — integration tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockGuestToken: vi.fn(),
  mockResolveLinkDocument: vi.fn(),
  mockCompleteJson: vi.fn(),
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
vi.mock('@/lib/link-preview', () => ({ resolveLinkDocument: mocks.mockResolveLinkDocument }))
vi.mock('@/lib/llm/client', () => ({ completeJson: mocks.mockCompleteJson }))

import { POST } from '../link/extract/route'
import { NextRequest } from 'next/server'

const { mockAuth, mockGuestToken, mockResolveLinkDocument, mockCompleteJson } = mocks

const SESSION_TOKEN = 'test_session_founder01'

function makePostRequest(body: object, token?: string) {
  const headers = new Headers({ 'Content-Type': 'application/json' })
  if (token) headers.set('Authorization', `Bearer ${token}`)
  return new NextRequest('http://localhost/api/sources/link/extract', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

describe('POST /api/sources/link/extract', () => {
  beforeEach(() => {
    mockAuth.mockResolvedValue({
      user: { id: 'user_founder01', isGuest: false, modelProvider: 'gemini' },
    })
    mockGuestToken.mockReturnValue(null)
    mockResolveLinkDocument.mockResolvedValue({
      ok: true,
      document: 'System design question bank. Eight questions. Grading rubric.',
      final_url: 'https://www.hellointerview.com/dashboard',
    })
    mockCompleteJson.mockResolvedValue({
      summary: 'This is the system-design question bank for interview prep.',
      key_points: ['8 practice questions', 'Grading rubric used in mock rounds'],
      extractable_items: ['Design Uber/Lyft', 'Design a URL shortener'],
      suggested_questions: ['Rank these by difficulty'],
    })
  })
  afterEach(() => { vi.clearAllMocks() })

  it('rejects unauthenticated requests with 401', async () => {
    mockAuth.mockResolvedValueOnce({ user: null })
    const res = await POST(makePostRequest({ url: 'https://example.com' }))
    expect(res.status).toBe(401)
  })

  it('returns 400 when neither url nor text is provided', async () => {
    const res = await POST(makePostRequest({}, SESSION_TOKEN))
    expect(res.status).toBe(400)
  })

  it('runs the LLM over pasted text and returns the extraction', async () => {
    const res = await POST(
      makePostRequest({ text: 'Design Uber. Design a URL shortener.' }, SESSION_TOKEN),
    )
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.ok).toBe(true)
    expect(data.extract.summary).toMatch(/system-design question bank/)
    expect(data.extract.extractable_items).toContain('Design Uber/Lyft')
    // Pasted text is passed straight to the resolver (no URL fetch).
    expect(mockResolveLinkDocument).toHaveBeenCalledWith({
      url: '',
      text: 'Design Uber. Design a URL shortener.',
    })
    expect(mockCompleteJson).toHaveBeenCalled()
  })

  it('forwards the resolved document to the LLM as context', async () => {
    await POST(makePostRequest({ url: 'https://www.hellointerview.com/dashboard' }, SESSION_TOKEN))
    const args = mockCompleteJson.mock.calls[0][0]
    expect(args.system).toMatch(/DOCUMENT|page content/i)
    expect(args.prompt).toContain('System design question bank')
  })

  it('returns ok:false with a human error when the document cannot be read', async () => {
    mockResolveLinkDocument.mockResolvedValueOnce({
      ok: false,
      document: '',
      error: 'This link is private or requires sign-in.',
    })
    const res = await POST(makePostRequest({ url: 'https://gated.example.com' }, SESSION_TOKEN))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.ok).toBe(false)
    expect(data.error).toMatch(/sign-in/)
    expect(mockCompleteJson).not.toHaveBeenCalled()
  })
})