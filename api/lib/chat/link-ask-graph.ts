/**
 * Link ask — LangGraph StateGraph for the to-and-fro link exploration chat.
 *
 * Mirrors `ops-graph.ts` (the general/scoped chat graph) but stripped to
 * one concern: answering the user's questions ABOUT a fetched/pasted
 * document. No state-changing tools, no proposals, no clarify routing —
 * the document is fixed for the lifetime of the dialog, and every turn
 * just streams a grounded answer.
 *
 * Graph:
 *
 *   START → n_generate ─→ n_finalize → END
 *
 * `n_generate` streams prose deltas to the client via `getWriter()` (the
 * route forwards them as SSE `delta`) using `streamChat` (AI SDK) with the
 * document embedded in the system prompt. `n_finalize` publishes the
 * `result` custom chunk (prose + fullText).
 */

import { Annotation, END, START, StateGraph, getWriter } from '@langchain/langgraph'

import { streamChat, type ChatMessage } from '@/lib/emergent/stream-chat'
import type { ProviderId } from '@/lib/emergent/model-registry'

export interface LinkAskGraphArgs {
  userId: string
  provider: ProviderId
  /** LinkReader system prompt + the resolved document. */
  system: string
  /** Q&A history (oldest first). */
  messages: ChatMessage[]
}

export interface LinkAskResult {
  prose: string
  fullText: string
}

const LinkState = Annotation.Root({
  fullText: Annotation<string>({ reducer: (_a, b) => b, default: () => '' }),
  prose: Annotation<string>({ reducer: (_a, b) => b, default: () => '' }),
  result: Annotation<LinkAskResult | null>({
    reducer: (_a, b) => b,
    default: () => null,
  }),
})

type LinkStateType = typeof LinkState.State
type LinkUpdate = typeof LinkState.Update

/** Write a custom stream chunk if we're inside a `streamMode: 'custom'` run. */
function emit(chunk: unknown): void {
  const w = getWriter()
  if (w) w(chunk)
}

export function buildLinkAskGraph(args: LinkAskGraphArgs) {
  const { userId, provider, system, messages } = args

  /* Node 1 — stream the grounded answer. */
  const generateNode = async (): Promise<LinkUpdate> => {
    let fullText = ''
    let proseEmitted = 0

    for await (const ev of streamChat({
      provider,
      system,
      messages,
      sessionId: userId,
    })) {
      if (ev.type === 'text_delta') {
        fullText += ev.content
        // Stream everything — there are no [[TOOLS]] blocks in this graph,
        // so no back-pressure hold. Emit only the not-yet-emitted suffix.
        if (fullText.length > proseEmitted) {
          emit({ type: 'delta', content: fullText.slice(proseEmitted) })
          proseEmitted = fullText.length
        }
      } else if (ev.type === 'stream_done') {
        if (ev.content && ev.content.length > fullText.length) fullText = ev.content
      }
    }

    return { fullText, prose: fullText }
  }

  /* Node 2 — publish the result custom chunk. */
  const finalizeNode = async (s: LinkStateType): Promise<LinkUpdate> => {
    const result: LinkAskResult = { prose: s.prose, fullText: s.fullText }
    emit({ type: 'result', ...result })
    return { result }
  }

  return new StateGraph(LinkState)
    .addNode('n_generate', generateNode)
    .addNode('n_finalize', finalizeNode)
    .addEdge(START, 'n_generate')
    .addEdge('n_generate', 'n_finalize')
    .addEdge('n_finalize', END)
    .compile()
}