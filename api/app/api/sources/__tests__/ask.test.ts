/**
 * POST /api/sources/link/ask — SSE integration tests.
 *
 * The route is a thin shell: resolve document → run the LangGraph
 * `buildLinkAskGraph` with `streamMode:'custom'` → forward deltas. The
 * LangGraph itself is tested separately; here we mock the compiled graph
 * (same shape `ops-graph` tests use) to assert the wire contract.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockGuestToken: vi.fn(),
  mockResolveLinkDocument: vi.fn(),
  mockStreamGraph: vi.fn(),
  mockBuildLinkAskGraph: vi.fn(),
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
vi.mock('@/lib/chat/link-ask-graph', () => ({
  buildLinkAskGraph: mocks.mockBuildLinkAskGraph,
}))

import { POST } from '../link/ask/route'
import { NextRequest } from 'next/server'

const { mockAuth, mockGuestToken, mockResolveLinkDocument, mockStreamGraph, mockBuildLinkAskGraph } = mocks

const SESSION_TOKEN = 'test_session_founder01'

function makePostRequest(body: object, token?: string) {
  const headers = new Headers({ 'Content-Type': 'application/json' })
  if (token) headers.set('Authorization', `Bearer ${token}`)
  return new NextRequest('http://localhost/api/sources/link/ask', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

async function readSse(res: Response): Promise<Array<Record<string, unknown>>> {
  const text = await res.text()
  return text
    .split('\n\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)))
}

describe('POST /api/sources/link/ask', () => {
  beforeEach(() => {
    mockAuth.mockResolvedValue({
      user: { id: 'user_founder01', isGuest: false, modelProvider: 'gemini' },
    })
    mockGuestToken.mockReturnValue(null)
    mockResolveLinkDocument.mockResolvedValue({
      ok: true,
      document: 'Eight system design questions.',
      final_url: 'https://www.hellointerview.com/dashboard',
    })
    mockStreamGraph.mockImplementation(async function* () {
      yield { type: 'delta', content: 'From easiest to hardest: ' }
      yield { type: 'delta', content: 'URL shortener, rate limiter.' }
      yield { type: 'result', prose: 'From easiest to hardest: URL shortener, rate limiter.', fullText: 'x' }
    })
    mockBuildLinkAskGraph.mockReturnValue({
      stream: mockStreamGraph,
    })
  })
  afterEach(() => { vi.clearAllMocks() })

  it('rejects unauthenticated requests with 401', async () => {
    mockAuth.mockResolvedValueOnce({ user: null })
    const res = await POST(makePostRequest({ url: 'https://example.com', messages: [{ role: 'user', content: 'hi' }] }))
    expect(res.status).toBe(401)
  })

  it('returns 400 when both url and text are missing', async () => {
    const res = await POST(makePostRequest({ messages: [{ role: 'user', content: 'hi' }] }, SESSION_TOKEN))
    expect(res.status).toBe(400)
  })

  it('returns 400 when messages are empty', async () => {
    const res = await POST(makePostRequest({ url: 'https://example.com', messages: [] }, SESSION_TOKEN))
    expect(res.status).toBe(400)
  })

  it('streams delta events then done (langgraph over resolved document)', async () => {
    const res = await POST(
      makePostRequest({
        url: 'https://www.hellointerview.com/dashboard',
        messages: [{ role: 'user', content: 'Rank these by difficulty' }],
      }, SESSION_TOKEN),
    )
    expect(res.status).toBe(200)
    const events = await readSse(res)
    expect(events.filter((e) => e.type === 'delta').map((e) => e.content).join(''))
      .toBe('From easiest to hardest: URL shortener, rate limiter.')
    const done = events.find((e) => e.type === 'done')
    expect(done).toBeTruthy()
    expect(done!.message_id).toMatch(/^ask_/)
    // The graph was given the resolved document as grounding.
    const graphArgs = mockBuildLinkAskGraph.mock.calls[0][0]
    expect(graphArgs.system).toContain('Eight system design questions')
    expect(graphArgs.messages[0].content).toBe('Rank these by difficulty')
    // Graph ran in custom stream mode (LangGraph → getWriter contract).
    const [, config] = mockStreamGraph.mock.calls[0]
    expect(config.streamMode).toBe('custom')
  })

  it('emits an error event when the page cannot be read', async () => {
    mockResolveLinkDocument.mockResolvedValueOnce({
      ok: false,
      document: '',
      error: 'This link is private or requires sign-in.',
    })
    const res = await POST(
      makePostRequest({ url: 'https://gated.example.com', messages: [{ role: 'user', content: 'hi' }] }, SESSION_TOKEN),
    )
    const events = await readSse(res)
    expect(events[0].type).toBe('error')
    expect(events[0].content).toMatch(/sign-in/)
    expect(mockStreamGraph).not.toHaveBeenCalled()
  })
})