/**
 * Goal Planner — typed stage contracts (Stage 1 Intake, Stage 3 Plan,
 * Stage 4 Emit) + the per-intent allowed-action sets.
 *
 * These are the single source of truth the pipeline validates against. Names
 * line up with the PRD glossary on purpose — a mismatch there is a bug.
 *
 * Deviation from the PRD sketch (deliberate): the shared `PlanSchema` does NOT
 * enforce 3-8 milestones / 1-3 commitments, because those bounds are specific
 * to the `add_goal` intent — `drop_goal` / `plan_day` legitimately emit fewer.
 * The intent-specific bounds are enforced in `crossValidate()` when
 * `intent === 'add_goal'`.
 */

import { z } from 'zod'

import {
  HORIZONS,
  MAX_BLOCKERS,
  MAX_CLARIFYING_QUESTIONS,
  MAX_COMMITMENTS,
  MAX_MILESTONES,
  MAX_PLAN_BLOCKS,
  MAX_PHASES,
  MAX_TOOLS,
  MAX_WEEKLY_HOURS,
  MIN_PHASES,
  MIN_WEEKLY_HOURS,
} from './config'

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM')
const blockKind = z.enum(['commitment', 'routine', 'blocker', 'focus'])

export const HorizonSchema = z.enum(HORIZONS)

/* -------------------------------------------------------------------------- */
/* Intents & actions                                                          */
/* -------------------------------------------------------------------------- */

export const INTENTS = [
  'add_goal',
  'plan_day',
  'edit_goal',
  'drop_goal',
  'review_progress',
] as const
export const IntentSchema = z.enum(INTENTS)
export type Intent = z.infer<typeof IntentSchema>

export const PLANNING_MODES = ['auto', 'ask', 'grill'] as const
export type PlanningMode = (typeof PLANNING_MODES)[number]

/** The four renegotiation buttons surfaced when Stage 3.5 says no. */
export const RenegotiationOptionSchema = z.enum([
  'shift_existing_target',
  'drop_existing_commitment',
  'extend_new_timeline',
  'reduce_new_hours',
])
export type RenegotiationOption = z.infer<typeof RenegotiationOptionSchema>

/** Proposal actions applied by api/lib/proposal-executor.ts. */
export const TOOL_ACTIONS = [
  'create_goal',
  'update_goal',
  'drop_goal',
  'pause_goal',
  'set_goal_dates',
  'add_milestone',
  'add_blocker',
  'add_block',
  'add_commitment',
  'complete_commitment',
] as const
export const ToolActionSchema = z.enum(TOOL_ACTIONS)
export type ToolAction = z.infer<typeof ToolActionSchema>

/** Tool actions each intent is permitted to emit (Stage 4 enforcement). */
export const ALLOWED_ACTIONS: Record<Intent, readonly ToolAction[]> = {
  // `set_goal_dates` is allowed for add_goal specifically for the
  // shift-existing-target renegotiation option: when the new plan doesn't
  // fit, the user may choose to push an existing goal's timeline out. The
  // cross-validator still requires the referenced goal to exist and any
  // dates to come from the plan.
  add_goal: ['create_goal', 'add_milestone', 'add_blocker', 'add_commitment', 'set_goal_dates'],
  plan_day: ['add_block', 'add_commitment', 'complete_commitment', 'add_blocker'],
  edit_goal: [
    'update_goal',
    'set_goal_dates',
    'add_milestone',
    'add_blocker',
    'add_commitment',
  ],
  drop_goal: ['drop_goal', 'pause_goal'],
  review_progress: [
    'update_goal',
    'set_goal_dates',
    'add_commitment',
    'complete_commitment',
    'add_blocker',
    'pause_goal',
    'drop_goal',
  ],
}

/* -------------------------------------------------------------------------- */
/* Per-action arg schemas (cross-validator Stage 4)                           */
/* -------------------------------------------------------------------------- */

export const ACTION_ARG_SCHEMAS: Record<ToolAction, z.ZodTypeAny> = {
  create_goal: z
    .object({
      title: z.string().min(1),
      horizon: HorizonSchema,
      why: z.string().optional(),
      first_action: z.string().optional(),
      next_action: z.string().optional(),
      target_date: isoDate.optional(),
      start_date: isoDate.optional(),
      weekly_hours: z
        .number()
        .min(MIN_WEEKLY_HOURS)
        .max(MAX_WEEKLY_HOURS)
        .optional(),
      phase_objectives: z.record(z.string()).optional(),
      life_area: z.string().optional(),
    })
    .passthrough(),
  add_milestone: z
    .object({
      goal_title: z.string().min(1),
      title: z.string().min(1),
      target_date: isoDate,
      phase: z.string().min(1),
    })
    .passthrough(),
  add_blocker: z
    .object({
      title: z.string().min(1),
      start_date: isoDate,
      end_date: isoDate,
      note: z.string().optional(),
    })
    .passthrough(),
  add_block: z
    .object({
      block_date: isoDate,
      start_time: time,
      end_time: time,
      label: z.string().trim().min(1),
      kind: blockKind,
      goal_title: z.string().optional(),
      note: z.string().optional(),
    })
    .passthrough()
    .refine((block) => block.end_time > block.start_time, {
      path: ['end_time'],
      message: 'end_time must be after start_time',
    }),
  add_commitment: z
    .object({
      goal_title: z.string().min(1),
      text: z.string().min(1),
      due: isoDate,
      phase: z.string().min(1),
    })
    .passthrough(),
  update_goal: z
    .object({ goal_title: z.string().optional(), goal_id: z.string().optional() })
    .passthrough(),
  drop_goal: z
    .object({ goal_title: z.string().optional(), goal_id: z.string().optional() })
    .passthrough(),
  pause_goal: z
    .object({ goal_title: z.string().optional(), goal_id: z.string().optional() })
    .passthrough(),
  set_goal_dates: z
    .object({ goal_title: z.string().optional(), goal_id: z.string().optional() })
    .passthrough(),
  complete_commitment: z
    .object({ text: z.string().optional(), commitment_id: z.string().optional() })
    .passthrough(),
}

/* -------------------------------------------------------------------------- */
/* Stage 1 — Intake                                                           */
/* -------------------------------------------------------------------------- */

export const ClarifyQuestionSchema = z.union([
  z.string().min(1),
  z.object({
    question: z.string().min(1),
    options: z.array(z.string().min(1)).max(6).optional(),
    multi: z.boolean().optional(),
  }),
])
export type ClarifyQuestion = z.infer<typeof ClarifyQuestionSchema>

export const IntakeSchema = z.object({
  shape: z.enum([
    'one_new_goal',
    'multiple_goals',
    'over_committed',
    'returning_after_gap',
    'meta_question',
    'routine_return',
  ]),
  needs_clarification: z.boolean(),
  clarifying_questions: z.array(ClarifyQuestionSchema).max(MAX_CLARIFYING_QUESTIONS),
  referenced_goal_titles: z.array(z.string()),
  framing_line: z.string(),
})
export type Intake = z.infer<typeof IntakeSchema>

/* -------------------------------------------------------------------------- */
/* Stage 3 — Plan                                                             */
/* -------------------------------------------------------------------------- */

export const PlanGoalSchema = z.object({
  title: z.string().min(1),
  horizon: HorizonSchema,
  why: z.string(),
  first_action: z.string(),
  start_date: isoDate,
  target_date: isoDate,
  weekly_hours: z.number().min(MIN_WEEKLY_HOURS).max(MAX_WEEKLY_HOURS),
  phase_objectives: z
    .record(z.string())
    .refine(
      (m) =>
        Object.keys(m).length >= MIN_PHASES &&
        Object.keys(m).length <= MAX_PHASES,
      `phase_objectives must have ${MIN_PHASES}-${MAX_PHASES} keys`,
    ),
})

export const PlanMilestoneSchema = z.object({
  title: z.string().min(1),
  target_date: isoDate,
  phase: z.string().min(1),
  rationale: z.string(),
})

export const PlanBlockerSchema = z.object({
  title: z.string().min(1),
  start_date: isoDate,
  end_date: isoDate,
  note: z.string().optional(),
})

export const PlanBlockSchema = z
  .object({
    block_date: isoDate,
    start_time: time,
    end_time: time,
    label: z.string().trim().min(1),
    kind: blockKind,
    goal_title: z.string().optional(),
    note: z.string().optional(),
  })
  .refine((block) => block.end_time > block.start_time, {
    path: ['end_time'],
    message: 'end_time must be after start_time',
  })

export const PlanCommitmentSchema = z.object({
  goal_title: z.string().min(1),
  text: z.string().min(1),
  due: isoDate,
  phase: z.string().min(1),
})

export const PlanSchema = z.object({
  goal: PlanGoalSchema.nullable(),
  milestones: z.array(PlanMilestoneSchema).max(MAX_MILESTONES),
  blockers: z.array(PlanBlockerSchema).max(MAX_BLOCKERS),
  blocks: z.array(PlanBlockSchema).max(MAX_PLAN_BLOCKS).default([]),
  commitments: z.array(PlanCommitmentSchema).max(MAX_COMMITMENTS),
  prose: z.string().min(1).max(500),
})
export type Plan = z.infer<typeof PlanSchema>
export type PlanGoal = z.infer<typeof PlanGoalSchema>

/* -------------------------------------------------------------------------- */
/* Stage 4 — Emit                                                             */
/* -------------------------------------------------------------------------- */

export const EmittedToolSchema = z.object({
  action: ToolActionSchema,
  args: z.record(z.any()),
})
export const EmitSchema = z.object({
  tools: z.array(EmittedToolSchema).min(1).max(MAX_TOOLS),
})
export type Emit = z.infer<typeof EmitSchema>
export type EmittedTool = z.infer<typeof EmittedToolSchema>
