import { describe, expect, it } from 'vitest'

import { runPlanPipeline, type CompleteFn, type PlanPipelineArgs } from '../orchestrator'
import { EmitSchema, IntakeSchema, PlanSchema } from '../schemas'
import type { Emit, Intake, Plan } from '../schemas'
import { buildLattice } from '../scheduler'

const TITLE = 'Land a senior SDE offer'

const intakeOk: Intake = {
  shape: 'one_new_goal',
  needs_clarification: false,
  clarifying_questions: [],
  referenced_goal_titles: [],
  framing_line: '',
}

const plan: Plan = {
  goal: {
    title: TITLE,
    horizon: 'short',
    why: 'gaps',
    first_action: 'Pick a resource',
    start_date: '2026-10-01',
    target_date: '2027-01-29',
    weekly_hours: 7,
    phase_objectives: {
      Foundations: 'SD Ch 1-12',
      Mocks: '5 mocks passed',
      Active: 'Offer in hand',
    },
  },
  milestones: [
    { title: 'SD fundamentals', target_date: '2026-11-05', phase: 'Foundations', rationale: 'x' },
    { title: '5 mocks', target_date: '2026-12-17', phase: 'Mocks', rationale: 'y' },
    { title: 'Offer', target_date: '2027-01-29', phase: 'Active', rationale: 'z' },
  ],
  blockers: [],
  blocks: [],
  commitments: [
    { goal_title: TITLE, text: 'Pick a resource', due: '2026-10-02', phase: 'Foundations' },
  ],
  prose: 'The daily slot is the load-bearing constraint.',
}

// Iteration 10.2: the scheduler owns milestone dates. The emit fixtures must
// carry the SCHEDULED dates or cross-validation (target_date must be in the
// plan's milestone dates) rejects them.
const schedMilestones = buildLattice({
  today: '2026-10-01',
  goal_title: TITLE,
  start_date: plan.goal!.start_date,
  target_date: plan.goal!.target_date,
  weekly_hours: plan.goal!.weekly_hours,
  phases: Object.entries(plan.goal!.phase_objectives).map(([name, objective]) => ({
    name,
    objective,
  })),
  milestones: plan.milestones.map((m) => ({
    title: m.title,
    phase: m.phase,
    rationale: m.rationale,
  })),
  commitments: plan.commitments.map((c) => ({ text: c.text, due: c.due, phase: c.phase })),
}).milestones
const MILE_DATE = new Map(schedMilestones.map((m) => [m.title, m.target_date]))

const emitOk: Emit = {
  tools: [
    {
      action: 'create_goal',
      args: { title: TITLE, horizon: 'short', target_date: '2027-01-29', weekly_hours: 7 },
    },
    {
      action: 'add_milestone',
      args: { goal_title: TITLE, title: 'SD fundamentals', target_date: MILE_DATE.get('SD fundamentals')!, phase: 'Foundations' },
    },
    {
      action: 'add_commitment',
      args: { goal_title: TITLE, text: 'Pick a resource', due: '2026-10-02', phase: 'Foundations' },
    },
  ],
}

const REVIEW_GOAL = 'Switch to a new job within 3 months'

/** An observation-only plan — schema-valid, but nothing to confirm. */
const emptyPlan: Plan = {
  goal: null,
  milestones: [],
  blockers: [],
  blocks: [],
  commitments: [],
  prose: 'The wedding only overlaps the final rounds.',
}

/** The corrected re-plan: no date move, but one confirmable next action. */
const reviewPlan: Plan = {
  goal: null,
  milestones: [],
  blockers: [],
  blocks: [],
  commitments: [
    {
      goal_title: REVIEW_GOAL,
      text: 'Re-check final-round scheduling after the wedding (Dec 16)',
      due: '2026-12-17',
      phase: 'Active',
    },
  ],
  prose: 'No date change needed — the wedding only overlaps the final rounds.',
}

const reviewEmit: Emit = {
  tools: [
    {
      action: 'add_commitment',
      args: {
        goal_title: REVIEW_GOAL,
        text: 'Re-check final-round scheduling after the wedding (Dec 16)',
        due: '2026-12-17',
        phase: 'Active',
      },
    },
  ],
}

function fakeComplete(opts: {
  intake?: unknown
  intakes?: unknown[]
  plan?: unknown
  plans?: unknown[]
  emits?: unknown[]
  throwAt?: 'intake' | 'plan' | 'emit'
}) {
  let emitIdx = 0
  let intakeIdx = 0
  let planIdx = 0
  return (async (args: { schema: unknown }) => {
    const meta = { mode: 'object' as const }
    if (args.schema === IntakeSchema) {
      if (opts.throwAt === 'intake') throw new Error('intake boom')
      const object = opts.intakes ? opts.intakes[intakeIdx++] : opts.intake
      return { object, meta }
    }
    if (args.schema === PlanSchema) {
      if (opts.throwAt === 'plan') throw new Error('plan boom')
      const object = opts.plans ? opts.plans[planIdx++] : opts.plan
      return { object, meta }
    }
    if (args.schema === EmitSchema) {
      if (opts.throwAt === 'emit') throw new Error('emit boom')
      return { object: opts.emits![emitIdx++], meta }
    }
    throw new Error('unexpected schema')
  }) as unknown as CompleteFn
}

function base(over: Partial<PlanPipelineArgs> = {}): PlanPipelineArgs {
  return {
    userId: 'u1',
    intent: 'add_goal',
    message: 'I want to switch jobs',
    context: 'LIVE STATE',
    provider: 'gemini',
    today: '2026-10-01',
    existingGoalTitles: [],
    budgetHours: 40,
    activeGoalWeeklyHours: [5],
    ...over,
  }
}

describe('runPlanPipeline', () => {
  it('runs a happy path and returns ok with tools + headroom', async () => {
    const res = await runPlanPipeline(
      base({
        deps: { complete: fakeComplete({ intake: intakeOk, plan, emits: [emitOk] }) },
      }),
    )
    expect(res.kind).toBe('ok')
    if (res.kind !== 'ok') return
    expect(res.tools).toHaveLength(3)
    expect(res.headroom?.decision).toBe('proceed')
    expect(res.modes).toEqual(['object', 'object', 'object'])
    expect(res.rejects).toEqual([])
  })

  it('returns clarify when Intake asks for it', async () => {
    const res = await runPlanPipeline(
      base({
        deps: {
          complete: fakeComplete({
            intake: { ...intakeOk, needs_clarification: true, clarifying_questions: ['By when?'] },
          }),
        },
      }),
    )
    expect(res.kind).toBe('clarify')
    if (res.kind === 'clarify') expect(res.questions).toEqual(['By when?'])
  })

  it('early-returns for the pure conversational shapes (meta / routine)', async () => {
    for (const shape of ['meta_question', 'routine_return'] as const) {
      const res = await runPlanPipeline(
        base({
          deps: {
            complete: fakeComplete({
              intake: { ...intakeOk, shape, framing_line: '…' },
            }),
          },
        }),
      )
      expect(res.kind).toBe('early')
      if (res.kind === 'early') expect(res.shape).toBe(shape)
    }
  })

  it('never early-returns for scoped action intents — the turn must reach plan + emit', async () => {
    // Regression: a blocker-collision re-plan was classified as a
    // conversational shape and early-returned a bare framing line, so the
    // user got an observation with no verdict and no action (twice). The
    // same gap applied to edit_goal / plan_day.
    const shapes = ['meta_question', 'routine_return', 'over_committed'] as const
    for (const intent of ['review_progress', 'edit_goal', 'plan_day'] as const) {
      for (const shape of shapes) {
        const res = await runPlanPipeline(
          base({
            intent,
            message: 'Re-plan around the wedding blocker.',
            existingGoalTitles: [REVIEW_GOAL],
            deps: {
              complete: fakeComplete({
                intake: { ...intakeOk, shape, framing_line: 'The wedding overlaps the final rounds.' },
                plan: reviewPlan,
                emits: [reviewEmit],
              }),
            },
          }),
        )
        expect(res.kind, `${intent}/${shape}`).toBe('ok')
        if (res.kind !== 'ok') continue
        expect(res.tools.some((t) => t.action === 'add_commitment')).toBe(true)
      }
    }
  })

  it('re-asks Stage 3 once when a scoped action intent plans nothing, then recovers', async () => {
    for (const intent of ['review_progress', 'edit_goal', 'plan_day'] as const) {
      const res = await runPlanPipeline(
        base({
          intent,
          message: 'Re-plan around the wedding blocker.',
          existingGoalTitles: [REVIEW_GOAL],
          deps: {
            complete: fakeComplete({ intake: intakeOk, plans: [emptyPlan, reviewPlan], emits: [reviewEmit] }),
          },
        }),
      )
      expect(res.kind, intent).toBe('ok')
      if (res.kind !== 'ok') continue
      expect(res.tools.some((t) => t.action === 'add_commitment')).toBe(true)
      expect(res.rejects.some((r) => r.stage === 'plan' && r.recovered)).toBe(true)
    }
  })

  it('degrades to no_change if a scoped action intent still plans nothing after the retry', async () => {
    const res = await runPlanPipeline(
      base({
        intent: 'review_progress',
        message: 'Re-plan around the wedding blocker.',
        existingGoalTitles: [REVIEW_GOAL],
        deps: { complete: fakeComplete({ intake: intakeOk, plans: [emptyPlan, emptyPlan] }) },
      }),
    )
    expect(res.kind).toBe('no_change')
    if (res.kind === 'no_change') expect(res.prose).toBe(emptyPlan.prose)
  })

  it('routes over_committed add_goal into headroom instead of early-returning', async () => {
    // Full plate: the pipeline must PLAN first, then let Stage 3.5 offer ways
    // to make room — not early-return with a clarifying question.
    const res = await runPlanPipeline(
      base({
        budgetHours: 10,
        activeGoalWeeklyHours: [5, 5],
        deps: {
          complete: fakeComplete({
            intake: { ...intakeOk, shape: 'over_committed', framing_line: 'Plate is full.' },
            plan,
            emits: [emitOk],
          }),
        },
      }),
    )
    expect(res.kind).toBe('renegotiate')
  })

  it('over_committed on a non-scoped-action intent (drop_goal) still early-returns', async () => {
    // review_progress / edit_goal / plan_day are now exempt (they always
    // plan); drop_goal keeps the conversational early-return and relies on
    // the route's deterministic forced-drop net.
    const res = await runPlanPipeline(
      base({
        intent: 'drop_goal',
        deps: {
          complete: fakeComplete({
            intake: { ...intakeOk, shape: 'over_committed', framing_line: 'Plate is full.' },
          }),
        },
      }),
    )
    expect(res.kind).toBe('early')
    if (res.kind === 'early') expect(res.shape).toBe('over_committed')
  })

  it('returns renegotiate (with 4 options) when headroom says no', async () => {
    const res = await runPlanPipeline(
      base({
        budgetHours: 10,
        activeGoalWeeklyHours: [5, 5],
        deps: { complete: fakeComplete({ intake: intakeOk, plan, emits: [emitOk] }) },
      }),
    )
    expect(res.kind).toBe('renegotiate')
    if (res.kind === 'renegotiate') {
      expect(res.options).toHaveLength(4)
      expect(res.headroom.decision).toBe('renegotiate')
    }
  })

  it('falls back to no_change when renegotiation rounds are exhausted', async () => {
    const res = await runPlanPipeline(
      base({
        budgetHours: 10,
        activeGoalWeeklyHours: [5, 5],
        renegotiation: { round: 2, choice: 'reduce_new_hours', priorPlan: plan, constraint: 'x' },
        deps: { complete: fakeComplete({ intake: intakeOk, plan, emits: [emitOk] }) },
      }),
    )
    expect(res.kind).toBe('no_change')
  })

  it('recovers from one cross-validation failure (records recovered reject)', async () => {
    const badEmit: Emit = {
      tools: [
        {
          action: 'add_milestone',
          args: { goal_title: TITLE, title: 'SD fundamentals', target_date: '2000-01-01', phase: 'Foundations' },
        },
      ],
    }
    const res = await runPlanPipeline(
      base({
        deps: {
          complete: fakeComplete({ intake: intakeOk, plan, emits: [badEmit, emitOk] }),
        },
      }),
    )
    expect(res.kind).toBe('ok')
    expect(res.rejects.some((r) => r.stage === 'cross_validate' && r.recovered)).toBe(true)
  })

  it('never throws — two cross-validation failures become no_change', async () => {
    const badEmit: Emit = {
      tools: [
        {
          action: 'add_milestone',
          args: { goal_title: 'nope', title: 'x', target_date: '2000-01-01', phase: 'Nope' },
        },
      ],
    }
    const res = await runPlanPipeline(
      base({
        deps: { complete: fakeComplete({ intake: intakeOk, plan, emits: [badEmit, badEmit] }) },
      }),
    )
    expect(res.kind).toBe('no_change')
  })

  it('degrades to no_change when a stage throws', async () => {
    const res = await runPlanPipeline(
      base({ deps: { complete: fakeComplete({ intake: intakeOk, throwAt: 'plan' }) } }),
    )
    expect(res.kind).toBe('no_change')
  })

  it('drops an invented blocker and its add_blocker tool', async () => {
    const planWithBlocker: Plan = {
      ...plan,
      blockers: [{ title: 'Travel', start_date: '2026-11-01', end_date: '2026-11-05', note: '' }],
    }
    const emitWithBlocker: Emit = {
      tools: [
        ...emitOk.tools,
        { action: 'add_blocker', args: { title: 'Travel', start_date: '2026-11-01', end_date: '2026-11-05' } },
      ],
    }
    const res = await runPlanPipeline(
      base({
        // base() message names no blocker cue
        deps: { complete: fakeComplete({ intake: intakeOk, plan: planWithBlocker, emits: [emitWithBlocker] }) },
      }),
    )
    expect(res.kind).toBe('ok')
    if (res.kind !== 'ok') return
    expect(res.tools.some((t) => t.action === 'add_blocker')).toBe(false)
    expect(res.rejects.some((r) => r.recovered && r.reason.includes('invented'))).toBe(true)
  })

  it('keeps a blocker the user actually named', async () => {
    const planWithBlocker: Plan = {
      ...plan,
      blockers: [{ title: 'Travel', start_date: '2026-11-01', end_date: '2026-11-05', note: '' }],
    }
    const emitWithBlocker: Emit = {
      tools: [
        ...emitOk.tools,
        { action: 'add_blocker', args: { title: 'Travel', start_date: '2026-11-01', end_date: '2026-11-05' } },
      ],
    }
    const res = await runPlanPipeline(
      base({
        message: 'Switch jobs — I have a travel trip in November.',
        deps: { complete: fakeComplete({ intake: intakeOk, plan: planWithBlocker, emits: [emitWithBlocker] }) },
      }),
    )
    expect(res.kind).toBe('ok')
    if (res.kind !== 'ok') return
    expect(res.tools.some((t) => t.action === 'add_blocker')).toBe(true)
  })

  it('keeps clarifying across turns, then plans when the remaining details are answered', async () => {
    const complete = fakeComplete({
      intakes: [
        { ...intakeOk, needs_clarification: true, clarifying_questions: ['Which interview areas need work?'] },
        { ...intakeOk, needs_clarification: true, clarifying_questions: ['Have you started applying?'] },
        intakeOk,
      ],
      plan,
      emits: [emitOk],
    })
    const threadId = `t-${Math.random().toString(36).slice(2)}`

    const first = await runPlanPipeline(base({ threadId, deps: { complete } }))
    expect(first.kind).toBe('clarify')
    if (first.kind === 'clarify') {
      expect(first.questions).toEqual(['Which interview areas need work?'])
    }

    const second = await runPlanPipeline(
      base({ threadId, message: 'System design and behavioral.', resume: 'System design and behavioral.', deps: { complete } }),
    )
    expect(second.kind).toBe('clarify')
    if (second.kind === 'clarify') expect(second.questions).toEqual(['Have you started applying?'])

    const third = await runPlanPipeline(
      base({ threadId, message: 'I have not applied yet.', resume: 'I have not applied yet.', deps: { complete } }),
    )
    expect(third.kind).toBe('ok')
    if (third.kind === 'ok') expect(third.tools).toHaveLength(3)
  })

  it('switching to auto bypasses a pending clarify and plans from the full history', async () => {
    const needsMore = {
      ...intakeOk,
      needs_clarification: true,
      clarifying_questions: ['One more important detail?'],
    }
    const complete = fakeComplete({ intakes: [needsMore, needsMore], plan, emits: [emitOk] })
    const threadId = `auto-${Math.random().toString(36).slice(2)}`
    const first = await runPlanPipeline(base({ threadId, mode: 'ask', deps: { complete } }))
    expect(first.kind).toBe('clarify')

    const resumed = await runPlanPipeline(
      base({ threadId, mode: 'auto', message: 'Use reasonable assumptions.', resume: 'Use reasonable assumptions.', deps: { complete } }),
    )
    expect(resumed.kind).toBe('ok')
  })
})

describe('clarification round cap', () => {
  it('stops asking after MAX_CLARIFYING_ROUNDS and proceeds to a plan', async () => {
    // Intake ALWAYS wants to clarify; only the round cap should stop it.
    const alwaysAsk = {
      ...intakeOk,
      needs_clarification: true,
      clarifying_questions: [{ question: 'Which level?' }],
    }
    const threadId = `thread-cap-${Date.now()}`
    const complete = fakeComplete({ intake: alwaysAsk, plan, emits: [emitOk] })
    const args = base({ mode: 'ask', threadId, deps: { complete } })

    const r1 = await runPlanPipeline(args)
    expect(r1.kind).toBe('clarify')

    // Round 1 answered -> may ask once more (budget = 2).
    const r2 = await runPlanPipeline({ ...args, resume: 'a1' })
    expect(r2.kind).toBe('clarify')

    // Round 2 answered -> budget spent -> forced to plan, no more asking.
    const r3 = await runPlanPipeline({ ...args, resume: 'a2' })
    expect(r3.kind).toBe('ok')
  })
})
