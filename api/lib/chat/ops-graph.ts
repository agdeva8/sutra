/**
 * Chat ops — LangGraph StateGraph for the general/scoped chat turn.
 *
 * This is the surface that produces EVERY state-changing proposal: create /
 * update / drop / pause a goal, set dates, add milestones / blockers /
 * commitments, complete a commitment. It used to be a ~250-line inline block
 * inside `/api/chat/stream`; it is now an explicit graph that streams through
 * the AI SDK (`streamChat` → `streamText`) with LangGraph orchestration.
 *
 * Graph:
 *
 *   START → n_generate ─┬─(prose-only, auto-answer)→ n_refine ─┐
 *                       └──────────────────────────→ n_finalize ←┘
 *                                                        │
 *                                                       END
 *
 * `n_generate` streams prose deltas to the client via `getWriter()` (the
 * route forwards them as SSE `delta`), then parses the `[[TOOLS]]` block.
 * `n_refine` is the silent follow-up that asks the model to emit tools only.
 * `n_finalize` applies the grill-me + drop safety nets and the general-chat
 * read-only filter, then publishes the `result` custom chunk.
 *
 * The `[[TOOLS]]` text protocol is intentionally preserved (AI SDK transport,
 * legacy parse) so the SSE wire format and the frontend are unchanged.
 */

import { Annotation, END, START, StateGraph, getWriter } from '@langchain/langgraph'

import {
  parseDropIntent,
  proposeGoalFromMessage,
  splitProseAndTools,
  TOOL_START,
  type Proposal,
} from '@/lib/emergent/llm'
import { streamChat } from '@/lib/emergent/stream-chat'
import type { ProviderId } from '@/lib/emergent/model-registry'

export type ConvKind =
  | 'general'
  | 'add_goal'
  | 'plan_day'
  | 'review_progress'
  | 'edit_goal'
  | 'drop_goal'

export interface OpsGraphArgs {
  userId: string
  provider: ProviderId
  /** SYSTEM_PROMPT + LIVE STATE & MEMORY + optional inline mode hint. */
  system: string
  coreMessages: Array<{ role: 'user' | 'assistant'; content: string }>
  scopedKind: ConvKind
  autoAnswer: boolean
  clarify: boolean
  message: string
  convTitle: string
  userGoals: Array<{ id: string; title: string; status?: string }>
}

/**
 * A clarification question. Plain string when there's nothing to tap; an object
 * carrying 2-5 short `options` (and `multi`) when the answer is a choice, so the
 * Ask card can render chips instead of only a free-text box.
 */
export type ClarifyQuestion =
  | string
  | { question: string; options?: string[]; multi?: boolean }

/** Normalize an ask proposal's args into a ClarifyQuestion (string when no options). */
function readAskQuestion(args: Record<string, unknown>): ClarifyQuestion | null {
  const q = args?.question
  if (typeof q !== 'string' || !q.trim()) return null
  const options = Array.isArray(args.options)
    ? (args.options as unknown[]).filter((o): o is string => typeof o === 'string' && o.trim().length > 0)
    : []
  const multi = args.multi === true
  if (options.length === 0 && !multi) return q
  return { question: q, ...(options.length ? { options } : {}), ...(multi ? { multi: true } : {}) }
}

export interface OpsGraphResult {
  prose: string
  proposals: Proposal[]
  needsClarification: string | null
  clarifyingQuestions: ClarifyQuestion[]
  fullText: string
}

const OpsState = Annotation.Root({
  fullText: Annotation<string>({ reducer: (_a, b) => b, default: () => '' }),
  prose: Annotation<string>({ reducer: (_a, b) => b, default: () => '' }),
  proposals: Annotation<Proposal[]>({ reducer: (_a, b) => b, default: () => [] }),
  hadToolsBlock: Annotation<boolean>({ reducer: (_a, b) => b, default: () => false }),
  needsClarification: Annotation<string | null>({ reducer: (_a, b) => b, default: () => null }),
  clarifyingQuestions: Annotation<ClarifyQuestion[]>({ reducer: (_a, b) => b, default: () => [] }),
  result: Annotation<OpsGraphResult | null>({ reducer: (_a, b) => b, default: () => null }),
})

type OpsStateType = typeof OpsState.State
type OpsUpdate = typeof OpsState.Update

/** Write a custom stream chunk if we're inside a `streamMode: 'custom'` run. */
function emit(chunk: unknown): void {
  const w = getWriter()
  if (w) w(chunk)
}

export function buildOpsGraph(args: OpsGraphArgs) {
  const { userId, provider, system, coreMessages, scopedKind, autoAnswer, clarify, message, convTitle, userGoals } = args

  /* Node 1 — primary generation (streams prose deltas). */
  const generateNode = async (): Promise<OpsUpdate> => {
    let fullText = ''
    let proseEmitted = 0
    let inTools = false

    for await (const ev of streamChat({
      provider,
      system,
      messages: coreMessages,
      sessionId: userId,
    })) {
      if (ev.type === 'text_delta') {
        fullText += ev.content
        if (inTools) continue

        const toolIdx = fullText.indexOf(TOOL_START)
        if (toolIdx === -1) {
          // Hold back the last `TOOL_START.length` chars in case the delimiter
          // is split across chunks.
          const safeUpTo = Math.max(proseEmitted, fullText.length - TOOL_START.length)
          if (autoAnswer && !clarify && safeUpTo > proseEmitted) {
            emit({ type: 'delta', content: fullText.slice(proseEmitted, safeUpTo) })
            proseEmitted = safeUpTo
          }
        } else {
          if (autoAnswer && !clarify && toolIdx > proseEmitted) {
            emit({ type: 'delta', content: fullText.slice(proseEmitted, toolIdx) })
          }
          proseEmitted = toolIdx
          inTools = true
        }
      } else if (ev.type === 'stream_done') {
        if (ev.content && ev.content.length > fullText.length) fullText = ev.content
      }
    }

    const { prose, proposals } = splitProseAndTools(fullText)
    return {
      fullText,
      prose,
      proposals,
      hadToolsBlock: fullText.includes(TOOL_START),
    }
  }

  /* Node 2 — silent follow-up: force a [[TOOLS]] block. */
  const refineNode = async (s: OpsStateType): Promise<OpsUpdate> => {
    emit({ type: 'delta', content: '\n\nFinishing the concrete proposal…' })
    const todayDate = new Date().toISOString().split('T')[0]
    const ninetyDaysOut = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split('T')[0]

    const followUpMessages = [
      ...coreMessages,
      { role: 'assistant' as const, content: s.prose },
      {
        role: 'user' as const,
        content:
          'SYSTEM CORRECTION — your previous turn only stated assumptions in prose. ' +
          'You MUST now emit a [[TOOLS]] block so the user has something concrete to confirm. ' +
          "If the user's message implies a single concrete goal, just propose it — do NOT ask for more detail.\n\n" +
          'Reply with EXACTLY this shape — one create_goal plus 2-4 add_milestone actions:\n\n' +
          '[[TOOLS]]\n' +
          '[\n' +
          `  {"action":"create_goal","title":"<concise title>","horizon":"short","why":"<one sentence>","first_action":"<smallest next step>","target_date":"${todayDate}"},\n` +
          `  {"action":"add_milestone","goal_title":"<same title as above>","title":"<milestone 1>","description":"<what done looks like>","why":"<why this step matters>","target_date":"${todayDate}"},\n` +
          `  {"action":"add_milestone","goal_title":"<same title as above>","title":"<milestone 2>","description":"<what done looks like>","why":"<why this step matters>","target_date":"${ninetyDaysOut}"}\n` +
          ']\n' +
          '[[/TOOLS]]\n\n' +
          "Use TODAY's date from LIVE STATE as the target_date anchor. " +
          'If the user gave no explicit deadline, set target_date ~90 days from today. ' +
          'State your single biggest assumption in one short prose line, then emit the [[TOOLS]] block.',
      },
    ]

    let followUpFull = ''
    try {
      for await (const ev of streamChat({
        provider,
        system,
        messages: followUpMessages,
        sessionId: userId,
      })) {
        if (ev.type === 'text_delta') followUpFull += ev.content
      }
    } catch {
      // Best-effort: keep the original prose, emit `done` without proposals.
      return {}
    }

    const { prose: followUpProse, proposals: followUpProposals } = splitProseAndTools(followUpFull)
    if (followUpProposals.length > 0) {
      if (followUpProse) emit({ type: 'delta', content: `\n\n${followUpProse}` })
      return {
        prose: followUpProse ? `${s.prose}\n\n${followUpProse}` : s.prose,
        proposals: followUpProposals,
      }
    }
    const questions = extractClarifyingQuestions(followUpProse || followUpFull || s.prose)
    if (questions.length > 0) {
      return {
        prose: followUpProse || s.prose,
        clarifyingQuestions: questions,
        needsClarification:
          'I want to make a real proposal, but I need a couple of details first.',
      }
    }
    return {}
  }

  /* Ask/Grill follow-up — never emit tools; collect tailored missing details. */
  const askNode = async (s: OpsStateType): Promise<OpsUpdate> => {
    const mode = clarify ? 'GRILL' : 'ASK'
    const followUpMessages = [
      ...coreMessages,
      ...(s.prose ? [{ role: 'assistant' as const, content: s.prose }] : []),
      {
        role: 'user' as const,
        content:
          `MODE: ${mode}. Read the full recent conversation and ask only for details that materially ` +
          'change this plan. ASK mode assumes low-impact details. GRILL mode asks every material ' +
          'unanswered detail, in tailored rounds with no total-round limit. Ask up to 6 questions now; ' +
          'do not repeat answered questions. For a job change, check readiness gaps, application/interview ' +
          'stage, weekly effort, and constraints. For a whole-day schedule, check wake/sleep times and ' +
          'fixed commitments. If an attached source has no readable text, say so rather than guessing. ' +
          'Reply with one [[TOOLS]] block of {"action":"ask","question":"…"} entries — one per question. ' +
          'When a question is a CHOICE, include 3-5 SHORT "options" (and "multi":true when several can ' +
          'apply) so the user can tap instead of typing. Do not propose any state change.',
      },
    ]

    let answer = ''
    try {
      for await (const ev of streamChat({
        provider,
        system,
        messages: followUpMessages,
        sessionId: userId,
      })) {
        if (ev.type === 'text_delta') answer += ev.content
      }
    } catch {
      // A safe deterministic question is better than silently dropping a request.
    }

    const { prose: answerProse, proposals: answerProps } = splitProseAndTools(answer)
    // Prefer the model's `ask` entries — they can carry tap-able options; fall
    // back to scraping `?` sentences from prose when no tools block came back.
    const asked: ClarifyQuestion[] = answerProps
      .filter((p) => p.action === 'ask')
      .map((p) => readAskQuestion(p.args as Record<string, unknown>))
      .filter((q): q is ClarifyQuestion => q !== null)
    let questions: ClarifyQuestion[] =
      asked.length > 0 ? asked : extractClarifyingQuestions(answerProse)
    if (questions.length === 0) {
      questions = scopedKind === 'plan_day'
        ? ['What time will you wake up and go to sleep, and what fixed commitments must the plan fit around?']
        : /job|career|role|switch/i.test(message)
        ? [
            'Which interview areas are strong already, and which need work (for example DSA, system design, or behavioral)?',
            'Have you started applying or interviewing, and how many hours per week can you spend on this?',
          ]
        : ['What missing detail would change the plan most, and how much time can you realistically give it?']
    }
    const prose =
      answerProse ||
      questions.map((q) => (typeof q === 'string' ? q : q.question)).join('\n')
    return {
      prose,
      proposals: [],
      clarifyingQuestions: questions,
      needsClarification: clarify
        ? 'I need a few more specifics before I can build a tailored plan:'
        : 'A few details will materially change the plan:',
    }
  }

  /* Node 3 — grill-me, drop safety net, general filter, publish result. */
  const finalizeNode = async (s: OpsStateType): Promise<OpsUpdate> => {
    let proposals = s.proposals
    let needsClarification = s.needsClarification
    let clarifyingQuestions = s.clarifyingQuestions
    let prose = s.prose

    // Ask/Grill can never display a state-changing proposal alongside
    // unanswered questions. After at least one clarification turn, a clean
    // proposal with no new questions means the coach is satisfied.
    if (clarify || !autoAnswer) {
      const questionsInProse = extractClarifyingQuestions(s.prose)
      const askQuestions: ClarifyQuestion[] = proposals
        .filter((proposal) => proposal.action === 'ask')
        .map((proposal) => readAskQuestion(proposal.args as Record<string, unknown>))
        .filter((question): question is ClarifyQuestion => question !== null)
      // Ask questions that carry tap-able options are the ones worth showing as
      // chips; prefer them over bare prose questions when they exist.
      const askWithOptions = askQuestions.filter(
        (q): q is { question: string; options?: string[]; multi?: boolean } =>
          typeof q !== 'string' && (q.options?.length ?? 0) > 0,
      )
      if (questionsInProse.length > 0 || clarifyingQuestions.length > 0 || askQuestions.length > 0) {
        proposals = proposals.filter((p) => p.action === 'navigate')
      }
      if (askWithOptions.length > 0) {
        clarifyingQuestions = askWithOptions
      } else if (clarifyingQuestions.length === 0) {
        clarifyingQuestions = questionsInProse.length > 0 ? questionsInProse : askQuestions
      }
      if (clarifyingQuestions.length > 0) {
        needsClarification =
          clarify
            ? 'Before I propose anything, I need a few specifics to tailor the plan:'
            : 'A few details will materially change the plan:'
      } else if (proposals.length === 0 && scopedKind !== 'general') {
        clarifyingQuestions = scopedKind === 'plan_day'
          ? ['What time will you wake up and go to sleep, and what fixed commitments must the plan fit around?']
          : ['What missing detail would change the plan most, and how much time can you realistically give it?']
        needsClarification = 'A few details will materially change the plan:'
        prose = needsClarification
      }
      if (needsClarification && clarifyingQuestions.length > 0) prose = needsClarification
    }

    // Final-tier safety net. For a drop/pause conversation this ALWAYS runs
    // regardless of auto-answer; for every other scoped kind it only fires
    // in auto-answer mode and only synthesizes a create_goal.
    const isDropConv = scopedKind === 'drop_goal'
    if (!clarify && scopedKind !== 'general' && message.length > 0 && (autoAnswer || isDropConv)) {
      const dropCandidates = userGoals
        .filter((g) => g.status !== 'dropped')
        .map((g) => ({ title: g.title, goalId: g.id }))
      const directDrop = parseDropIntent(message, dropCandidates)
      const contextualDrop =
        isDropConv && !directDrop
          ? parseDropIntent(message, dropCandidates, { contextText: convTitle })
          : null

      if (
        isDropConv &&
        contextualDrop &&
        proposals.length > 0 &&
        proposals.every((p) => p.action === 'ask')
      ) {
        // The terse confirmation resolved the coach's ask — swap the ask for
        // the real drop instead of asking again (ask loop).
        proposals = [contextualDrop]
      } else if (proposals.length === 0) {
        const dropProposal = directDrop || contextualDrop
        if (dropProposal) {
          proposals = [dropProposal]
        } else if (autoAnswer) {
          const synthesized = proposeGoalFromMessage(message)
          if (synthesized) {
            proposals = [synthesized]
          } else if (!needsClarification) {
            clarifyingQuestions = extractClarifyingQuestions(s.prose)
            if (clarifyingQuestions.length > 0) {
              needsClarification = 'Tell me a little more so I can shape a real proposal:'
            }
          }
        }
      }
    }

    // General chat is a read-only navigator — keep only navigate / ask.
    if (scopedKind === 'general') {
      proposals = proposals.filter((p) => p.action === 'navigate' || p.action === 'ask')
    }

    const result: OpsGraphResult = {
      prose,
      proposals,
      needsClarification,
      clarifyingQuestions,
      fullText: s.fullText,
    }
    if ((clarify || !autoAnswer) && prose) emit({ type: 'delta', content: prose })
    emit({ type: 'result', ...result })
    return { result }
  }

  const afterGenerate = (s: OpsStateType): string => {
    const needsClarificationMode = clarify || !autoAnswer
    const hasQuestions = extractClarifyingQuestions(s.prose).length > 0
    // Ask/Grill must not propose on a bare first turn, and must keep pushing
    // while the reply leans on assumptions. It DOES stop once we have asked
    // and the answer produced an assumption-free proposal: the clarification
    // turn is persisted as one of finalize's fixed prompts, so search for
    // those rather than a '?' (the prompt itself never has one).
    const askedBefore = coreMessages.some(
      (m) =>
        m.role === 'assistant' &&
        /details will materially change|need a few specifics|few details first|shape a real proposal/i.test(
          m.content,
        ),
    )
    const reliesOnAssumptions = /\b(assum(?:e|ing|ption)|guess(?:ing)?)\b/i.test(s.prose)
    if (
      needsClarificationMode &&
      scopedKind !== 'general' &&
      message.length > 0 &&
      !hasQuestions &&
      (s.proposals.length === 0 || !askedBefore || reliesOnAssumptions)
    ) {
      return 'n_ask'
    }

    const shouldRefine =
      s.proposals.length === 0 &&
      autoAnswer &&
      !clarify &&
      scopedKind !== 'general' &&
      s.prose.trim().length > 0 &&
      !s.hadToolsBlock
    return shouldRefine ? 'n_refine' : 'n_finalize'
  }

  return new StateGraph(OpsState)
    .addNode('n_generate', generateNode)
    .addNode('n_refine', refineNode)
    .addNode('n_ask', askNode)
    .addNode('n_finalize', finalizeNode)
    .addEdge(START, 'n_generate')
    .addConditionalEdges('n_generate', afterGenerate, {
      n_refine: 'n_refine',
      n_ask: 'n_ask',
      n_finalize: 'n_finalize',
    })
    .addEdge('n_refine', 'n_finalize')
    .addEdge('n_ask', 'n_finalize')
    .addEdge('n_finalize', END)
    .compile()
}

/* -------------------------------------------------------------------------- */
/* extractClarifyingQuestions — pull 1-2 short questions out of a coach turn  */
/* -------------------------------------------------------------------------- */

export function extractClarifyingQuestions(text: string, max = 6): string[] {
  if (!text || !text.trim()) return []

  const cleaned = text
    .replace(/\r/g, '')
    .split(/\n+/)
    .map((line) => line.replace(/^\s*(?:\d+[.)]\s+|[-*•]\s+)/, '').trim())
    .filter(Boolean)
    .join(' ')

  const sentences = cleaned
    .split(/(?<=[.?!])\s+(?=[A-Z(])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= 220 && s.endsWith('?'))

  const seen = new Set<string>()
  const out: string[] = []
  for (const s of sentences) {
    const key = s.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
    if (out.length >= max) break
  }
  return out
}
