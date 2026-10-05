/**
 * Goal Planner — orchestrator, now a LangGraph StateGraph.
 *
 * The pipeline is expressed as an explicit graph instead of a linear
 * function so state is durable and HITL is first-class:
 *
 *   START → intake ─┬─(needs_clarification)→ clarify ─┐
 *                   ├─(early shape)────────→ END      │
 *                   └──────────────(else)──→ plan ←────┘ (resume)
 *                                             │
 *                                          headroom
 *                                             │
 *                          ┌─(over budget)→ renegotiate (result)
 *                          └─(fits)───────→ emit → cross_validate ─┐
 *                                                            │     │
 *                                            (cv fail, retry)└─────┘
 *
 * `intake` → `clarify` is a real LangGraph `interrupt()`: the graph pauses,
 * the checkpointer (`PostgresSaver` in prod, `MemorySaver` in dev/test)
 * persists state, and the next request resumes with `Command({ resume })`.
 *
 * Everything else — the deterministic cross-validator, the programmatic
 * headroom check, the anti-hallucination blocker gate — is unchanged and
 * lives in the same pure modules (`cross-validator.ts`, `headroom.ts`).
 *
 * Safety contract (unchanged): never throws for a model/cross-validation
 * failure — such failures become `kind: 'no_change'` with a `plan_rejects`
 * record. Only programmer errors throw.
 */

import 'server-only'

import { randomUUID } from 'node:crypto'

import {
  Annotation,
  Command,
  END,
  START,
  StateGraph,
  interrupt,
  type BaseCheckpointSaver,
} from '@langchain/langgraph'
import type { z } from 'zod'

import type { ProviderId } from '@/lib/emergent/model-registry'

import { clearPlanThread, ensurePlanCheckpointerSetup, getPlanCheckpointer, isPlanPersistenceEnabled } from './checkpointer'
import { MAX_CLARIFYING_ROUNDS, MAX_RENEGOTIATION_ROUNDS } from './config'
import { crossValidate } from './cross-validator'
import { checkHeadroom, type HeadroomResult } from './headroom'
import { completeJsonWithMeta } from './llm'
import type { CompleteJsonArgs, CompleteJsonMeta } from './llm'
import {
  emitPrompt,
  emitRetrySuffix,
  intakePrompt,
  planPrompt,
  RENEGOTIATION_OPTIONS,
} from './prompts'
import { buildLattice, type PlanItemRow } from './scheduler'
import { decomposePlanItems } from './decompose'
import {
  EmitSchema,
  IntakeSchema,
  type ClarifyQuestion,
  PlanSchema,
  type Emit,
  type EmittedTool,
  type Intent,
  type Intake,
  type Plan,
  type PlanningMode,
  type RenegotiationOption,
} from './schemas'

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export type CompleteFn = <S extends z.ZodTypeAny>(
  args: CompleteJsonArgs<S>,
) => Promise<{ object: z.infer<S>; meta: CompleteJsonMeta }>

export const DEFAULT_COMPLETE: CompleteFn = completeJsonWithMeta

export type PlanStage = 'intake' | 'plan' | 'emit' | 'cross_validate'

export interface PlanRejectRecord {
  intent: Intent
  stage: PlanStage
  reason: string
  rawInput: unknown
  rawOutput: unknown
  recovered: boolean
}

export interface PlanPipelineArgs {
  userId: string
  intent: Intent
  mode?: PlanningMode
  message: string
  /** `buildContext(...)` output — the LIVE STATE & MEMORY string. */
  context: string
  provider: ProviderId
  /** ISO YYYY-MM-DD. */
  today: string
  /** Titles of the user's non-dropped goals (for cross-validation). */
  existingGoalTitles: string[]
  /** `users.available_weekly_hours`; null = advisory headroom. */
  budgetHours: number | null
  /**
   * `users.availability` — weekday → free hours. `null`/empty means the user
   * has never set it, so Stage 1 asks the availability questions (once, on
   * their first goal). After that it's reused.
   */
  availability: Record<string, number> | null
  /** `weekly_hours` for each active goal (null = not yet estimated). */
  activeGoalWeeklyHours: ReadonlyArray<number | null>
  renegotiation?: {
    round: number
    choice: RenegotiationOption
    priorPlan: Plan
    constraint: string
  }
  /**
   * Stable thread id for durable execution. When set, the graph is compiled
   * with the shared checkpointer and state persists across requests. Omitted
   * in unit tests (an ephemeral MemorySaver + random thread id is used).
   */
  threadId?: string
  /**
   * HITL resume value. When defined, the graph is re-invoked with
   * `Command({ resume })` against `threadId`, continuing a paused clarify.
   */
  resume?: unknown
  abortSignal?: AbortSignal
  deps?: { complete: CompleteFn }
}

export type PlanPipelineResult =
  | { kind: 'clarify'; prompt: string; questions: ClarifyQuestion[]; rejects: PlanRejectRecord[] }
  | { kind: 'early'; shape: Intake['shape']; prose: string; rejects: PlanRejectRecord[] }
  | { kind: 'no_change'; reason: string; prose: string; rejects: PlanRejectRecord[] }
  | {
      kind: 'renegotiate'
      prose: string
      headroom: HeadroomResult
      options: RenegotiationOption[]
      plan: Plan
      /** Multi-horizon lattice (id-less plan_items rows). */
      planItems: PlanItemRow[]
      rejects: PlanRejectRecord[]
    }
  | {
      kind: 'ok'
      prose: string
      tools: EmittedTool[]
      plan: Plan
      headroom: HeadroomResult | null
      /** Multi-horizon lattice (id-less plan_items rows). */
      planItems: PlanItemRow[]
      modes: CompleteJsonMeta['mode'][]
      rejects: PlanRejectRecord[]
    }

/* -------------------------------------------------------------------------- */
/* Graph state                                                                */
/* -------------------------------------------------------------------------- */

const PlannerState = Annotation.Root({
  intake: Annotation<Intake | null>({ reducer: (_a, b) => b, default: () => null }),
  /** Completed HITL clarification rounds — caps the ask/gill loop. */
  clarifyRounds: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }),
  plan: Annotation<Plan | null>({ reducer: (_a, b) => b, default: () => null }),
  /** Multi-horizon execution lattice computed by the deterministic scheduler. */
  planItems: Annotation<PlanItemRow[]>({
    reducer: (_a, b) => b,
    default: () => [],
  }),
  headroom: Annotation<HeadroomResult | null>({ reducer: (_a, b) => b, default: () => null }),
  emit: Annotation<Emit | null>({ reducer: (_a, b) => b, default: () => null }),
  cvErrors: Annotation<string[]>({ reducer: (_a, b) => b, default: () => [] }),
  emitAttempts: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }),
  /** Accumulated across nodes AND across resume — reducer concatenates. */
  rejects: Annotation<PlanRejectRecord[]>({
    reducer: (a, b) => a.concat(b),
    default: () => [],
  }),
  modes: Annotation<CompleteJsonMeta['mode'][]>({
    reducer: (a, b) => a.concat(b),
    default: () => [],
  }),
  result: Annotation<PlanPipelineResult | null>({ reducer: (_a, b) => b, default: () => null }),
})

type PlanState = typeof PlannerState.State
type PlanUpdate = typeof PlannerState.Update

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Blocker cue heuristic. The PRD forbids the LLM inventing blockers, and
 * blockers are direct-CRUD data anyway (hard constraint #2), so we only keep
 * model-produced blockers when the user's own words point at one.
 */
const BLOCKER_CUE =
  /\b(travel|trip|vacation|holiday|wedding|conference|exam|exams|launch|deadline|away|moving|relocat\w*|surgery|hospital|busy|blocker|blocked|out of town|on leave|festival|ceremony|visa)\b/i

export function messageMentionsBlocker(message: string): boolean {
  return BLOCKER_CUE.test(message)
}

/**
 * Intents opened to perform a concrete action on an existing goal/day.
 * These skip the conversational early-return so the turn always reaches the
 * plan stage and lands on a verdict + a confirmable action. `add_goal` is not
 * here because its `over_committed` shape must flow through headroom, and
 * `drop_goal` is covered by the route's deterministic forced-drop net.
 */
const SCOPED_ACTION_INTENTS = new Set<Intent>([
  'review_progress',
  'edit_goal',
  'plan_day',
])

/**
 * True when a plan carries nothing the user can confirm: no goal and no
 * milestones / blockers / commitments / blocks. `PlanSchema` allows this
 * (only `prose` is required), so the graph must reject it explicitly for the
 * scoped action intents — otherwise an observation-only turn reaches emit,
 * which either fails to ground a tool or fabricates one.
 */
function isEmptyPlan(plan: Plan): boolean {
  return (
    !plan.goal &&
    plan.milestones.length === 0 &&
    plan.blockers.length === 0 &&
    plan.blocks.length === 0
  )
}

/* -------------------------------------------------------------------------- */
/* Graph builder                                                              */
/* -------------------------------------------------------------------------- */

interface BuildGraphArgs {
  config: PlanPipelineArgs
  complete: CompleteFn
  checkpointer: BaseCheckpointSaver
}

/**
 * Build the compiled planner graph. Built per invocation because `complete`
 * and `config` are captured in the node closures (the unit tests inject a
 * fake `complete`); the checkpointer is the shared/durable piece.
 */
function buildPlannerGraph({ config: pArgs, complete, checkpointer }: BuildGraphArgs) {
  const reject = (
    stage: PlanStage,
    reason: string,
    rawInput: unknown,
    rawOutput: unknown,
    recovered = false,
  ): PlanRejectRecord => ({
    intent: pArgs.intent,
    stage,
    reason,
    rawInput,
    rawOutput,
    recovered,
  })

  const call = async <S extends z.ZodTypeAny>(
    schema: S,
    prompt: string,
  ): Promise<{ object: z.infer<S>; mode: CompleteJsonMeta['mode'] }> => {
    const { object, meta } = await complete({
      provider: pArgs.provider,
      schema,
      prompt,
      abortSignal: pArgs.abortSignal,
    })
    return { object, mode: meta.mode }
  }

  /* Stage 1 — Intake ---------------------------------------------------- */
  const intakeNode = async (s: PlanState): Promise<PlanUpdate> => {
    const round = s.clarifyRounds ?? 0
    // Hard cap: once the round budget is spent, never ask again — proceed and
    // let the plan state assumptions. This is what stops the ask/gill loop.
    const roundsExhausted = round >= MAX_CLARIFYING_ROUNDS
    // The questions we asked last round are persisted on the checkpointed
    // intake. Feed them back so the model recognises its own prior questions
    // (and their answers) instead of re-asking reworded duplicates.
    const priorQuestions = (s.intake?.clarifying_questions ?? [])
      .map((q) => (typeof q === 'string' ? q : q.question))
      .filter((q): q is string => typeof q === 'string' && q.length > 0)
    try {
      const { object: parsedIntake, mode } = await call(
        IntakeSchema,
        intakePrompt({
          intent: pArgs.intent,
          mode: pArgs.mode ?? 'ask',
          message: pArgs.message,
          context: pArgs.context,
          today: pArgs.today,
          round,
          maxRounds: MAX_CLARIFYING_ROUNDS,
          priorQuestions,
          availabilityKnown:
            !!pArgs.availability && Object.keys(pArgs.availability).length > 0,
        }),
      )
      const forceProceed = pArgs.mode === 'auto' || roundsExhausted
      const intake: Intake = forceProceed
        ? { ...parsedIntake, needs_clarification: false, clarifying_questions: [] }
        : parsedIntake
      const updates: PlanUpdate = { intake, modes: [mode] }

      // Pure conversational shapes early-return; `over_committed` only for
      // non-add_goal (add_goal must flow through headroom to make room).
      //
      // Scoped action intents are exempt: those conversations exist to decide
      // something concrete (shift dates / reduce scope / accept the slip, edit
      // a goal, plan a day). The `early` shape carries only a one-line framing
      // and skips plan → emit, which left the user staring at an observation
      // with no verdict and nothing to confirm. They always reach the plan
      // stage.
      const conversationalShape =
        intake.shape === 'meta_question' ||
        (intake.shape === 'routine_return' && pArgs.intent !== 'plan_day' && pArgs.resume === undefined) ||
        (intake.shape === 'over_committed' && pArgs.intent !== 'add_goal')
      if (conversationalShape && !SCOPED_ACTION_INTENTS.has(pArgs.intent)) {
        updates.result = {
          kind: 'early',
          shape: intake.shape,
          prose: intake.framing_line,
          rejects: [],
        }
      }
      return updates
    } catch (e) {
      const rec = reject('intake', `intake failed: ${errMsg(e)}`, { message: pArgs.message }, null)
      return {
        rejects: [rec],
        result: {
          kind: 'no_change',
          reason: rec.reason,
          prose:
            'I could not read that as a planning request. Rephrase it or add a concrete next step.',
          rejects: [],
        },
      }
    }
  }

  /* HITL — clarify (LangGraph interrupt) -------------------------------- */
  const clarifyNode = async (s: PlanState): Promise<PlanUpdate> => {
    // Pauses here; the checkpointer persists state. On resume, `interrupt`
    // returns the user's answer and the graph continues to `plan` (the
    // resumed request's `message` is already the answer). Count the round so
    // the next intake knows its remaining budget.
    interrupt({
      kind: 'clarify',
      prompt:
        s.intake?.framing_line ||
        'A couple of details would change the plan meaningfully:',
      questions: s.intake?.clarifying_questions ?? [],
    })
    return { clarifyRounds: (s.clarifyRounds ?? 0) + 1 }
  }

  /* Stage 3 — Plan ------------------------------------------------------ */
  const planNode = async (): Promise<PlanUpdate> => {
    const planArgs = {
      intent: pArgs.intent,
      mode: pArgs.mode ?? 'ask',
      message: pArgs.message,
      context: pArgs.context,
      today: pArgs.today,
      renegotiation: pArgs.renegotiation,
    }
    let plan: Plan
    let mode: CompleteJsonMeta['mode']
    try {
      const res = await call(PlanSchema, planPrompt(planArgs))
      plan = res.object
      mode = res.mode
    } catch (e) {
      const rec = reject('plan', `plan failed: ${errMsg(e)}`, { message: pArgs.message }, null)
      return {
        rejects: [rec],
        result: {
          kind: 'no_change',
          reason: rec.reason,
          prose:
            'I could not turn that into a concrete plan. Add a deadline or a smallest first step and I will try again.',
          rejects: [],
        },
      }
    }

    const rejects: PlanRejectRecord[] = []
    // Anti-hallucination gate — drop blockers the user did not name.
    if (plan.blockers.length > 0 && !messageMentionsBlocker(pArgs.message)) {
      const invented = plan.blockers
      plan = { ...plan, blockers: [] }
      rejects.push(
        reject(
          'plan',
          `cleared ${invented.length} invented blocker(s)`,
          { blockers: invented },
          null,
          true,
        ),
      )
    }

    if (pArgs.intent === 'add_goal' && !plan.goal) {
      const rec = reject('plan', 'add_goal plan produced no goal', { plan }, null)
      return {
        plan,
        modes: [mode],
        rejects: [...rejects, rec],
        result: {
          kind: 'no_change',
          reason: rec.reason,
          prose: plan.prose || 'I did not get a concrete goal out of that.',
          rejects: [],
        },
      }
    }

    // A scoped action intent (re-plan / edit / day plan) must land on
    // something the user can confirm. `PlanSchema` permits an empty plan, so
    // re-ask Stage 3 once with a correction before degrading. This is the
    // structural guarantee behind "precise answer with an action" — the
    // prompt asks for it, this enforces it.
    if (SCOPED_ACTION_INTENTS.has(pArgs.intent) && isEmptyPlan(plan)) {
      const emptyFirst = plan
      const retrySuffix =
        `\n\n=== PLAN CARRIED NO ACTION — FIX AND RE-EMIT ===\n` +
        `A ${pArgs.intent} turn must land on something the user can confirm: a ` +
        `changed goal / date / scope, a commitment naming the next step, or ` +
        `day blocks. Return the same JSON shape with at least one concrete ` +
        `action, and make the prose open with the verdict.`
      try {
        const retry = await call(PlanSchema, planPrompt(planArgs) + retrySuffix)
        if (!isEmptyPlan(retry.object)) {
          plan = retry.object
          mode = retry.mode
          rejects.push(
            reject('plan', `${pArgs.intent} plan carried no action on first pass`, { plan: emptyFirst }, null, true),
          )
        } else {
          const rec = reject('plan', `${pArgs.intent} plan carried no action after retry`, { plan }, null)
          return {
            plan,
            modes: [mode],
            rejects: [...rejects, rec],
            result: { kind: 'no_change', reason: rec.reason, prose: plan.prose, rejects: [] },
          }
        }
      } catch (e) {
        const rec = reject('plan', `plan retry failed: ${errMsg(e)}`, { plan }, null)
        return {
          plan,
          modes: [mode],
          rejects: [...rejects, rec],
          result: { kind: 'no_change', reason: rec.reason, prose: plan.prose, rejects: [] },
        }
      }
    }

    // Deterministic scheduling — the scheduler owns EVERY date. It lays the
    // plan out as a multi-horizon lattice (yearly -> quarterly phases ->
    // monthly milestones -> weekly checkpoints -> daily commitments) with a
    // 20% per-horizon timeline buffer, and overwrites the model's rough
    // milestone dates. Everything downstream (headroom, emit, cross-validate,
    // executor) then sees the scheduled plan.
    let planItems: PlanItemRow[] = []
    if (
      plan.goal &&
      plan.milestones.length > 0 &&
      Object.keys(plan.goal.phase_objectives).length >= 2
    ) {
      try {
        const scheduled = buildLattice({
          today: pArgs.today,
          goal_title: plan.goal.title,
          start_date: plan.goal.start_date,
          target_date: plan.goal.target_date,
          weekly_hours: plan.goal.weekly_hours,
          phases: Object.entries(plan.goal.phase_objectives).map(([name, objective]) => ({
            name,
            objective,
          })),
          milestones: plan.milestones.map((m) => ({
            title: m.title,
            phase: m.phase,
            rationale: m.rationale,
          })),
        })
        plan = {
          ...plan,
          milestones: scheduled.milestones.map((m, i) => ({
            ...(plan.milestones[i] ?? m),
            target_date: m.target_date,
          })),
        }
        planItems = scheduled.items

        // Week → distinct days, availability-aware. Only when the user has
        // set availability; otherwise the lattice's cloned dailies stand.
        if (pArgs.availability && Object.keys(pArgs.availability).length > 0) {
          const blockedDates: string[] = []
          for (const b of plan.blockers) {
            if (!b.start_date || !b.end_date) continue
            const end = new Date(`${b.end_date}T00:00:00.000Z`)
            for (
              let d = new Date(`${b.start_date}T00:00:00.000Z`);
              d <= end;
              d.setUTCDate(d.getUTCDate() + 1)
            ) {
              blockedDates.push(d.toISOString().slice(0, 10))
            }
          }
          planItems = await decomposePlanItems(scheduled.items, {
            availability: pArgs.availability,
            blockedDates,
            provider: pArgs.provider,
            complete,
          })
        }
      } catch (e) {
        // Scheduling is pure arithmetic; a failure must not sink the plan.
        rejects.push(reject('plan', `scheduler failed: ${errMsg(e)}`, { plan }, null, true))
      }
    }

    return { plan, planItems, modes: [mode], rejects }
  }

  /* Stage 3.5 — Headroom (programmatic) -------------------------------- */
  const headroomNode = async (s: PlanState): Promise<PlanUpdate> => {
    const plan = s.plan
    if (!plan?.goal) return { headroom: null }

    const headroom = checkHeadroom({
      budgetHours: pArgs.budgetHours,
      activeGoals: pArgs.activeGoalWeeklyHours.map((weeklyHours) => ({ weeklyHours })),
      newWeeklyHours: plan.goal.weekly_hours,
    })

    if (headroom.decision === 'renegotiate') {
      const round = pArgs.renegotiation?.round ?? 0
      if (round >= MAX_RENEGOTIATION_ROUNDS) {
        const rec = reject('plan', `renegotiation exhausted: ${headroom.message}`, { headroom }, null)
        return {
          headroom,
          rejects: [rec],
          result: {
            kind: 'no_change',
            reason: rec.reason,
            prose: `Still over budget after ${MAX_RENEGOTIATION_ROUNDS} attempts. ${headroom.message} Try a smaller goal, or drop an existing one first.`,
            rejects: [],
          },
        }
      }
      return {
        headroom,
        result: {
          kind: 'renegotiate',
          prose: plan.prose,
          headroom,
          options: [...RENEGOTIATION_OPTIONS],
          plan,
          planItems: s.planItems ?? [],
          rejects: [],
        },
      }
    }

    return { headroom }
  }

  /* Stage 4 — Emit ------------------------------------------------------ */
  const emitNode = async (s: PlanState): Promise<PlanUpdate> => {
    const attempt = s.emitAttempts + 1
    const plan = s.plan
    if (!plan) {
      const rec = reject('emit', 'emit called with no plan', {}, null)
      return { rejects: [rec], result: { kind: 'no_change', reason: rec.reason, prose: '', rejects: [] } }
    }
    let emit: Emit
    try {
      const suffix = s.cvErrors.length > 0 ? emitRetrySuffix(s.cvErrors) : ''
      const res = await call(EmitSchema, emitPrompt({ intent: pArgs.intent, plan }) + suffix)
      emit = res.object
      // Keep only add_blocker tools grounded in the plan.
      const allowedBlockerKeys = new Set(plan.blockers.map((b) => `${b.start_date}|${b.end_date}`))
      const before = emit.tools.length
      const tools = emit.tools.filter((t) => {
        if (t.action !== 'add_blocker') return true
        const a = t.args as Record<string, unknown>
        return allowedBlockerKeys.has(`${a.start_date}|${a.end_date}`)
      })
      const rejects: PlanRejectRecord[] = []
      if (tools.length !== before) {
        rejects.push(
          reject('cross_validate', `dropped ${before - tools.length} ungrounded blocker tool(s)`, {}, null, true),
        )
      }
      return { emit: { tools }, emitAttempts: attempt, modes: [res.mode], rejects }
    } catch (e) {
      const rec = reject('emit', `emit ${attempt > 1 ? 'retry ' : ''}failed: ${errMsg(e)}`, { plan }, null)
      return { rejects: [rec], result: { kind: 'no_change', reason: rec.reason, prose: plan.prose, rejects: [] } }
    }
  }

  /* Stage 4.5 — Cross-validate (programmatic) --------------------------- */
  const crossValidateNode = async (s: PlanState): Promise<PlanUpdate> => {
    if (!s.plan || !s.emit) {
      const rec = reject('cross_validate', 'missing plan or emit', {}, null)
      return { rejects: [rec], result: { kind: 'no_change', reason: rec.reason, prose: '', rejects: [] } }
    }

    const cv = crossValidate({
      intent: pArgs.intent,
      plan: s.plan,
      emit: s.emit,
      today: pArgs.today,
      existingGoalTitles: pArgs.existingGoalTitles,
    })

    if (cv.ok) {
      const rejects: PlanRejectRecord[] = []
      // Recovered on retry — record the earlier failure, flagged.
      if (s.emitAttempts > 1 && s.cvErrors.length > 0) {
        rejects.push(reject('cross_validate', s.cvErrors.join('; '), { plan: s.plan }, s.cvErrors, true))
      }
      return {
        rejects,
        result: {
          kind: 'ok',
          prose: s.plan.prose,
          tools: s.emit.tools,
          plan: s.plan,
          headroom: s.headroom,
          planItems: s.planItems ?? [],
          modes: [],
          rejects: [],
        },
      }
    }

    if (s.emitAttempts < 2) {
      return { cvErrors: cv.errors }
    }

    const rec = reject(
      'cross_validate',
      `cross-validation failed: ${cv.errors.join('; ')}`,
      { plan: s.plan, emit: s.emit },
      cv.errors,
    )
    return { rejects: [rec], result: { kind: 'no_change', reason: rec.reason, prose: s.plan.prose, rejects: [] } }
  }

  /* Routers ------------------------------------------------------------- */
  const afterIntake = (s: PlanState): string => {
    if (s.result) return END
    if (s.intake?.needs_clarification && s.intake.clarifying_questions.length > 0) return 'n_clarify'
    return 'n_plan'
  }
  const afterPlan = (s: PlanState): string => (s.result ? END : 'n_headroom')
  const afterHeadroom = (s: PlanState): string => (s.result ? END : 'n_emit')
  const afterEmit = (s: PlanState): string => (s.result ? END : 'n_cross_validate')
  const afterCrossValidate = (s: PlanState): string => (s.result ? END : 'n_emit')

  return new StateGraph(PlannerState)
    .addNode('n_intake', intakeNode)
    .addNode('n_clarify', clarifyNode)
    .addNode('n_plan', planNode)
    .addNode('n_headroom', headroomNode)
    .addNode('n_emit', emitNode)
    .addNode('n_cross_validate', crossValidateNode)
    .addEdge(START, 'n_intake')
    .addConditionalEdges('n_intake', afterIntake, { n_clarify: 'n_clarify', n_plan: 'n_plan', [END]: END })
    // After each answer, re-run intake against the complete conversation.
    // ASK/GRILL can take as many clarification turns as the plan needs.
    .addEdge('n_clarify', 'n_intake')
    .addConditionalEdges('n_plan', afterPlan, { n_headroom: 'n_headroom', [END]: END })
    .addConditionalEdges('n_headroom', afterHeadroom, { n_emit: 'n_emit', [END]: END })
    .addConditionalEdges('n_emit', afterEmit, { n_cross_validate: 'n_cross_validate', [END]: END })
    .addConditionalEdges('n_cross_validate', afterCrossValidate, { n_emit: 'n_emit', [END]: END })
    .compile({ checkpointer })
}

/* -------------------------------------------------------------------------- */
/* Public entry                                                               */
/* -------------------------------------------------------------------------- */

type CompiledPlanner = {
  invoke: (
    input: unknown,
    config: unknown,
  ) => Promise<PlanState & { __interrupt__?: Array<{ value: unknown }> }>
  getState: (config: unknown) => Promise<{
    next?: unknown[]
    tasks?: Array<{ interrupts?: Array<{ value?: unknown }> }>
  }>
}

export async function runPlanPipeline(args: PlanPipelineArgs): Promise<PlanPipelineResult> {
  const complete = args.deps?.complete ?? DEFAULT_COMPLETE
  const checkpointer = await getPlanCheckpointer()
  if (args.threadId) await ensurePlanCheckpointerSetup()
  // Fresh run on a conversation thread → clear prior checkpoints so reducers
  // don't accumulate across runs. Resume keeps the thread intact.
  if (args.threadId && args.resume === undefined) {
    await clearPlanThread(args.threadId)
  }

  const graph = buildPlannerGraph({ config: args, complete, checkpointer }) as unknown as CompiledPlanner
  const threadId = args.threadId ?? `plan-${randomUUID()}`
  const config = { configurable: { thread_id: threadId } }
  const input = args.resume !== undefined ? new Command({ resume: args.resume }) : {}

  const out = await graph.invoke(input, config)

  const rejects = out.rejects ?? []

  if (out.__interrupt__ && out.__interrupt__.length > 0) {
    const value = out.__interrupt__[0].value as {
      kind?: string
      prompt?: string
      questions?: ClarifyQuestion[]
    }
    return {
      kind: 'clarify',
      prompt: value.prompt ?? 'A couple of details would change the plan meaningfully:',
      questions: value.questions ?? [],
      rejects,
    }
  }

  if (!out.result) {
    throw new Error('plan graph produced no result')
  }

  if (out.result.kind === 'ok') {
    return { ...out.result, modes: out.modes ?? [], rejects }
  }
  return { ...out.result, rejects }
}

/**
 * Inspect a thread for a pending clarify interrupt. Used by the route to
 * decide whether an incoming message is a HITL resume or a fresh run.
 * Returns null when persistence is off (dev/test) or nothing is pending.
 */
export async function getPendingPlanInterrupt(
  threadId: string,
): Promise<{ kind: 'clarify'; prompt: string; questions: ClarifyQuestion[] } | null> {
  if (!threadId || !isPlanPersistenceEnabled()) return null
  await ensurePlanCheckpointerSetup()
  const checkpointer = await getPlanCheckpointer()
  const graph = buildPlannerGraph({
    config: stubArgs(threadId),
    complete: DEFAULT_COMPLETE,
    checkpointer,
  }) as unknown as CompiledPlanner

  const snap = await graph.getState({ configurable: { thread_id: threadId } })
  for (const task of snap.tasks ?? []) {
    for (const i of task.interrupts ?? []) {
      const v = i.value as { kind?: string; prompt?: string; questions?: ClarifyQuestion[] } | undefined
      if (v && v.kind === 'clarify') {
        return { kind: 'clarify', prompt: v.prompt ?? '', questions: v.questions ?? [] }
      }
    }
  }
  return null
}

/** Minimal args for building a graph purely to read checkpoint state. */
function stubArgs(threadId: string): PlanPipelineArgs {
  return {
    userId: '',
    intent: 'add_goal',
    message: '',
    context: '',
    provider: 'gemini',
    today: new Date().toISOString().slice(0, 10),
    existingGoalTitles: [],
    budgetHours: null,
    availability: null,
    activeGoalWeeklyHours: [],
    threadId,
  }
}
