/**
 * Link ask graph — orchestration test.
 *
 * The transport (`streamChat`) is mocked with a scripted queue (same
 * pattern as ops-graph.test.ts); the real LangGraph StateGraph runs. Asserts
 * the streaming + result contract: every delta crosses the writer, and the
 * final result carries the full prose.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { scripts } = vi.hoisted(() => ({ scripts: [] as string[][] }))

vi.mock('@/lib/emergent/stream-chat', () => ({
  streamChat: async function* () {
    const script = scripts.shift() ?? []
    const full = script.join('')
    for (const t of script) yield { type: 'text_delta', content: t }
    yield { type: 'stream_done', content: full }
  },
}))

import { buildLinkAskGraph, type LinkAskGraphArgs, type LinkAskResult } from '../link-ask-graph'

function base(over: Partial<LinkAskGraphArgs> = {}): LinkAskGraphArgs {
  return {
    userId: 'u1',
    provider: 'gemini',
    system: 'LINK_READER_SYSTEM\n\n=== DOCUMENT ===\nEight system design questions.',
    messages: [{ role: 'user', content: 'Rank these by difficulty' }],
    ...over,
  }
}

async function run(args: LinkAskGraphArgs): Promise<{ result: LinkAskResult; deltas: string[] }> {
  const graph = buildLinkAskGraph(args)
  let result: LinkAskResult | null = null
  const deltas: string[] = []
  const it = await (graph.stream as unknown as (i: unknown, c: unknown) => Promise<AsyncIterable<unknown>>)(
    {},
    { streamMode: 'custom' },
  )
  for await (const c of it) {
    const chunk = c as { type?: string; content?: string }
    if (chunk.type === 'delta') deltas.push(chunk.content ?? '')
    else if (chunk.type === 'result') result = chunk as LinkAskResult
  }
  if (!result) throw new Error('no result chunk')
  return { result, deltas }
}

describe('buildLinkAskGraph', () => {
  beforeEach(() => {
    scripts.length = 0
  })

  it('streams every delta and publishes the full prose as result', async () => {
    scripts.push(['From easiest to hardest: ', 'URL shortener, rate limiter.'])
    const { result, deltas } = await run(base())
    expect(deltas.join('')).toBe('From easiest to hardest: URL shortener, rate limiter.')
    expect(result.prose).toBe('From easiest to hardest: URL shortener, rate limiter.')
    expect(result.fullText).toBe(result.prose)
  })

  it('passes the document-grounding system prompt through to streamChat', async () => {
    scripts.push(['OK.'])
    const args = base()
    await run(args)
    // The graph does not mutate the system prompt — the route owns it.
    expect(args.system).toContain('=== DOCUMENT ===')
    expect(args.system).toContain('Eight system design questions.')
  })

  it('handles an empty stream (no deltas) with an empty result', async () => {
    scripts.push([])
    const { result, deltas } = await run(base())
    expect(deltas).toHaveLength(0)
    expect(result.prose).toBe('')
  })
})