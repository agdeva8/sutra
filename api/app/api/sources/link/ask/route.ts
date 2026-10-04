/**
 * POST /api/sources/link/ask — to-and-fro Q&A about a fetched/pasted page.
 *
 * Iteration 11 — the to-and-fro chat surface inside LinkPreviewDialog.
 * The user asks questions about a link ("pull out the system-design
 * questions and rank them"), and the model answers grounded on the
 * document, streamed back token by token.
 *
 * Body: { url?: string; text?: string; messages: [{role, content}]; provider? }
 *   - `text` (pasted, gated pages) wins over `url`.
 *   - The conversation history is THE body — nothing is persisted; this is
 *     a stateless exploration chat for the life of the dialog.
 *
 * SSE wire format (matches LinkAskPanel's reader):
 *   data: {"type":"delta","content":"…"}
 *   data: {"type":"done","message_id":"…","provider":"…"}
 *   data: {"type":"error","content":"…"}
 *
 * Auth: Emergent OAuth OR guest cookie OR Bearer (test/dev compat).
 */

import { randomUUID } from 'node:crypto'

import { type NextRequest } from 'next/server'

import { resolveLinkDocument } from '@/lib/link-preview'
import { buildLinkAskGraph } from '@/lib/chat/link-ask-graph'
import { MODEL_REGISTRY, type ProviderId, type ChatMessage } from '@/lib/emergent/llm'
import { LINK_READER_SYSTEM } from '@/lib/llm/prompts'
import { resolveRequestUser } from '@/lib/request-user'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DEFAULT_PROVIDER: ProviderId = 'gemini'
const MAX_HISTORY = 24

export async function POST(req: NextRequest) {
  const caller = await resolveRequestUser(req)
  if (!caller) {
    return new Response('Unauthorized', { status: 401 })
  }

  let body: {
    url?: string
    text?: string
    messages?: unknown
    provider?: string
    goal?: string
  }
  try {
    body = await req.json()
  } catch {
    return new Response('Bad request', { status: 400 })
  }

  const url = typeof body?.url === 'string' ? body.url.trim() : ''
  const text = typeof body?.text === 'string' ? body.text.trim() : ''
  const goal = typeof body?.goal === 'string' ? body.goal.trim().slice(0, 500) : ''
  if (!url && !text) {
    return new Response('Bad request', { status: 400 })
  }

  const messages: ChatMessage[] = Array.isArray(body?.messages)
    ? (body.messages as Array<{ role?: string; content?: string }>)
        .filter(
          (m) =>
            m &&
            (m.role === 'user' || m.role === 'assistant') &&
            typeof m.content === 'string' &&
            m.content.trim().length > 0,
        )
        .map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content!.slice(0, 4000),
        }))
        .slice(-MAX_HISTORY)
    : []
  if (messages.length === 0) {
    return new Response('Bad request', { status: 400 })
  }

  const requestedProvider =
    typeof body.provider === 'string' && body.provider in MODEL_REGISTRY
      ? (body.provider as ProviderId)
      : ((caller.modelProvider as ProviderId | undefined) ?? DEFAULT_PROVIDER)

  const resolved = await resolveLinkDocument({ url, text })

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const enqueue = (obj: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`))
        } catch {
          /* stream closed */
        }
      }

      if (!resolved.ok) {
        enqueue({
          type: 'error',
          content: resolved.error ?? 'Could not read this page.',
        })
        controller.close()
        return
      }

      const graph = buildLinkAskGraph({
        userId: caller.userId,
        provider: requestedProvider,
        system:
          LINK_READER_SYSTEM +
          (goal
            ? `\n\n=== THE USER'S GOAL ===\n${goal}\nExtract and propose things that serve this goal — turn page content into plan steps, checklists, or gaps the user can act on.`
            : '') +
          `\n\n=== DOCUMENT ===\n` +
          resolved.document.slice(0, 8000),
        messages,
      })

      try {
        const runStream = await (graph.stream as unknown as (
          input: unknown,
          config: unknown,
        ) => Promise<AsyncIterable<unknown>>)({}, { streamMode: 'custom' })

        for await (const chunk of runStream) {
          const c = chunk as { type?: string; content?: string }
          if (c?.type === 'delta' && typeof c.content === 'string') {
            enqueue({ type: 'delta', content: c.content })
          }
          // `result` custom chunks are consumed internally; only deltas
          // and the final done/error events cross the wire.
        }

        enqueue({
          type: 'done',
          message_id: `ask_${Date.now()}_${randomUUID().slice(0, 8)}`,
          provider: requestedProvider,
        })
      } catch (e) {
        enqueue({
          type: 'error',
          content: `Model error: ${(e as Error).message ?? String(e)}`,
        })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    },
  })
}