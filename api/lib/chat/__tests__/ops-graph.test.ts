/**
 * Chat ops graph — orchestration tests.
 *
 * The model transport (`streamChat`) is mocked with a scripted queue; the
 * real `[[TOOLS]]` parser, drop heuristics, grill-me and general-chat filter
 * all run. Asserts the graph's streaming + final-result contract.
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

import { buildOpsGraph, extractClarifyingQuestions, type OpsGraphArgs, type OpsGraphResult } from '../ops-graph'

function base(over: Partial<OpsGraphArgs> = {}): OpsGraphArgs {
  return {
    userId: 'u1',
    provider: 'gemini',
    system: 'SYS',
    coreMessages: [{ role: 'user', content: 'hi' }],
    scopedKind: 'add_goal',
    autoAnswer: true,
    clarify: false,
    message: 'hi',
    convTitle: '',
    userGoals: [],
    ...over,
  }
}

async function run(args: OpsGraphArgs): Promise<{ result: OpsGraphResult; deltas: string[] }> {
  const graph = buildOpsGraph(args)
  let result: OpsGraphResult | null = null
  const deltas: string[] = []
  const it = await (graph.stream as unknown as (i: unknown, c: unknown) => Promise<AsyncIterable<unknown>>)(
    {},
    { streamMode: 'custom' },
  )
  for await (const c of it) {
    const chunk = c as { type?: string; content?: string }
    if (chunk.type === 'delta') deltas.push(chunk.content ?? '')
    else if (chunk.type === 'result') result = c as OpsGraphResult
  }
  if (!result) throw new Error('no result chunk')
  return { result, deltas }
}

describe('buildOpsGraph', () => {
  beforeEach(() => {
    scripts.length = 0
  })

  it('parses a [[TOOLS]] block and streams the prose before it', async () => {
    scripts.push([
      'Here is a concrete goal.\n\n[[TOOLS]]\n[{"action":"create_goal","title":"Learn Japanese"}]\n[[/TOOLS]]',
    ])
    const { result, deltas } = await run(base())
    expect(result.prose).toContain('Here is a concrete goal.')
    expect(result.prose).not.toContain('[[TOOLS]]')
    expect(result.proposals).toHaveLength(1)
    expect(result.proposals[0].action).toBe('create_goal')
    expect(deltas.join('')).toContain('Here is a concrete goal.')
    expect(deltas.join('')).not.toContain('[[TOOLS]]')
  })

  it('general chat is read-only — keeps only navigate/ask proposals', async () => {
    scripts.push(['[[TOOLS]]\n[{"action":"create_goal","title":"X"},{"action":"ask","question":"Which one?"}]\n[[/TOOLS]]'])
    const { result } = await run(base({ scopedKind: 'general' }))
    expect(result.proposals).toHaveLength(1)
    expect(result.proposals[0].action).toBe('ask')
  })

  it('refines a prose-only scoped turn into tools', async () => {
    scripts.push(['Let me assume a deadline.'])
    scripts.push(['[[TOOLS]]\n[{"action":"create_goal","title":"Run a 10k"}]\n[[/TOOLS]]'])
    const { result } = await run(base({ scopedKind: 'add_goal', autoAnswer: true }))
    // refine consumed the second script
    expect(scripts).toHaveLength(0)
    expect(result.proposals).toHaveLength(1)
    expect(result.proposals[0].action).toBe('create_goal')
  })

  it('resolves a contextual drop from the conversation title', async () => {
    scripts.push(['On it.'])
    const { result } = await run(
      base({
        scopedKind: 'drop_goal',
        autoAnswer: false,
        message: 'Drop it for good',
        convTitle: 'Drop "Switch jobs"?',
        userGoals: [{ id: 'g1', title: 'Switch jobs', status: 'active' }],
      }),
    )
    expect(result.proposals).toHaveLength(1)
    expect(result.proposals[0].action).toBe('drop_goal')
    expect(String(result.proposals[0].args.goal_title)).toBe('Switch jobs')
  })

  it('grill-me surfaces clarifying questions when no proposals are produced', async () => {
    scripts.push(['Should you commit 3 or 6 months?'])
    const { result } = await run(base({ scopedKind: 'plan_day', autoAnswer: false, clarify: true }))
    expect(result.proposals).toHaveLength(0)
    expect(result.clarifyingQuestions).toContain('Should you commit 3 or 6 months?')
    expect(result.needsClarification).toBeTruthy()
  })

  it('does not expose state-changing proposals in a grill turn that asks questions', async () => {
    scripts.push([
      'Which interview round is weakest? [[TOOLS]][{"action":"create_goal","title":"Switch jobs"}][[/TOOLS]]',
    ])
    const { result } = await run(base({ autoAnswer: false, clarify: true }))
    expect(result.proposals).toEqual([])
    expect(result.clarifyingQuestions).toEqual(['Which interview round is weakest?'])
    expect(result.needsClarification).toBeTruthy()
  })

  it('asks a tailored follow-up when grill tries to propose without questions', async () => {
    scripts.push(['A 3-month job transition plan. [[TOOLS]][{"action":"create_goal","title":"Switch jobs"}][[/TOOLS]]'])
    scripts.push(['Which interview areas need the most work? Have you started applying? How many hours per week can you spend?'])
    const { result } = await run(
      base({ autoAnswer: false, clarify: true, message: 'I want to switch jobs in 3 months.' }),
    )
    expect(result.proposals).toEqual([])
    expect(result.clarifyingQuestions).toHaveLength(3)
    expect(result.clarifyingQuestions[0]).toContain('interview areas')
  })

  it('extracts more than two important clarification questions', async () => {
    const questions = [
      'Which role are you targeting?',
      'Which interview areas need work?',
      'Have you started applying?',
      'How many hours per week are available?',
      'What constraints should the plan respect?',
    ].join(' ')
    expect(extractClarifyingQuestions(questions)).toHaveLength(5)
  })

  it('carries ask options through so the Ask card can render choice chips', async () => {
    // Turn 1 (generate): prose only, no questions → routes to the Ask node.
    scripts.push(['I need a couple of details first.'])
    // Turn 2 (ask): the model returns a choice question as an `ask` action.
    scripts.push([
      'Before I plan:\n\n[[TOOLS]]\n[{"action":"ask","question":"Which market?","options":["Same city","Remote-only","Open to relocating"],"multi":false}]\n[[/TOOLS]]',
    ])
    const { result } = await run(base({ autoAnswer: false, clarify: true, message: 'I want to switch jobs.' }))
    expect(result.proposals).toEqual([])
    expect(result.clarifyingQuestions).toHaveLength(1)
    const q = result.clarifyingQuestions[0]
    expect(typeof q).toBe('object')
    expect(q).toMatchObject({
      question: 'Which market?',
      options: ['Same city', 'Remote-only', 'Open to relocating'],
    })
  })

  it('attaches deterministic options for a known fork via the option bank', async () => {
    scripts.push(['I need a couple of details first.'])
    scripts.push([
      '[[TOOLS]]\n[{"action":"ask","question":"Which market should I target?"}]\n[[/TOOLS]]',
    ])
    const { result } = await run(base({ autoAnswer: false, clarify: true, message: 'I want to switch jobs.' }))
    expect(result.clarifyingQuestions).toHaveLength(1)
    expect(result.clarifyingQuestions[0]).toMatchObject({
      question: 'Which market should I target?',
      options: ['Same city', 'Remote-only', 'Open to relocating'],
    })
  })

  it('leaves an optionless question as a plain string (bank must not over-match)', async () => {
    scripts.push(['I need a couple of details first.'])
    scripts.push([
      '[[TOOLS]]\n[{"action":"ask","question":"Which interview round is weakest?"}]\n[[/TOOLS]]',
    ])
    const { result } = await run(base({ autoAnswer: false, clarify: true, message: 'I want to switch jobs.' }))
    expect(result.clarifyingQuestions).toEqual(['Which interview round is weakest?'])
  })
})
