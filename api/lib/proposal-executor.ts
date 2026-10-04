/**
 * Proposal executor — port of `apply_proposal` from backend/server.py:312-424.
 *
 * Source of truth:
 *   - backend/server.py:312-424 (the Python function we're porting)
 *   - migration/discovery/03-nextjs-architecture.md Section 4 ("Tool proposal model")
 *   - y/db/schema.ts (the Drizzle schema we write to)
 *
 * What this file is responsible for:
 *   - Take a confirmed proposal `{ id, action, args }` and write its effect
 *     to the goals / commitments / milestones / blockers tables.
 *   - Each action runs in its own Drizzle transaction so a partial write
 *     cannot leave the database in a half-updated state.
 *   - Return `{ success, result }` where `result` is the human-readable
 *     confirmation line shown back to the user (mirrors the Python
 *     `return f"…"` strings).
 *
 * What this file is NOT responsible for:
 *   - Updating `proposals.status` from pending -> confirmed. The route
 *     handler (`app/api/tools/confirm/route.ts`) does that so the status
 *     change is observable even when the underlying action is rejected by
 *     the executor (e.g. "no matching goal"). This mirrors the Python
 *     `_find_proposal` + `apply_proposal` split.
 *   - Auth. Route handlers must verify session ownership before calling
 *     `applyProposal`.
 *
 * Design decisions vs. the Python original:
 *   1. **ID-based, not title-based.** The Python version fuzzy-matches
 *      `goal_title` text. The new schema gives every row a stable string
 *      ID (`goal_xxx`, `commit_xxx` …) and every tool's zod schema
 *      requires `goal_id` / `commitment_id`. This eliminates the
 *      "no matching goal for 'Runn'" failure mode entirely.
 *   2. **One transaction per action.** Drizzle's `db.transaction` gives
 *      atomic per-action semantics. The Python original issued one Mongo
 *      `update_one` per action; Postgres transactions are cheap so we use
 *      them everywhere.
 *   3. **Lazy DB import.** Importing `@/lib/db` triggers env validation
 *      (DATABASE_URL etc.) at module load, which crashes the test suite
 *      where no env is configured. We `await import('@/lib/db')` inside
 *      each function instead. drizzle-orm itself has no side effects so
 *      its imports stay at the top of the file.
 */

import { randomUUID } from 'node:crypto'
import { and, eq, inArray, isNull } from 'drizzle-orm'

import { applyGoalDropCascade, resolveGoalRef } from '@/lib/goal-drop'

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export interface Proposal {
  id: string
  action: string
  args: Record<string, any>
}

export interface ApplyProposalResult {
  success: boolean
  result: string
}

/** Mirrors the Postgres enum in `db/schema.ts`. */
const HORIZONS = ['weekly', 'short', 'medium', 'long'] as const
type Horizon = (typeof HORIZONS)[number]

/** Mirrors the Postgres enum in `db/schema.ts`. */
const GOAL_STATUSES = ['active', 'paused', 'dropped'] as const
type GoalStatus = (typeof GOAL_STATUSES)[number]

/* -------------------------------------------------------------------------- */
/* Lazy DB / schema loaders                                                   */
/*                                                                             */
/* Imported as a function (not at module top-level) so vitest can load this   */
/* module without DATABASE_URL/AUTH_SECRET/etc. set. The production server    */
/* still gets env-validated at first request — `lib/env.ts` is a hard boot    */
/* gate, the lazy import just delays it from "import time" to "first call".   */
/* -------------------------------------------------------------------------- */

async function getDbAndSchema() {
  const [{ db }, schema] = await Promise.all([
    import('@/lib/db'),
    import('@/db/schema'),
  ])
  return { db, schema }
}

/* -------------------------------------------------------------------------- */
/* ID generator (mirrors backend `new_id(prefix)` shape)                     */
/* -------------------------------------------------------------------------- */

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

/** Today's date in ISO `YYYY-MM-DD` (UTC), matching Python's default. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

/* -------------------------------------------------------------------------- */
/* Plan items (multi-horizon execution lattice)                               */
/* -------------------------------------------------------------------------- */

/**
 * Write the schedule of record for a goal. Called inside the creator/editor
 * transaction with the resolved goal id so plan_items rows are keyed to the
 * goal the user just confirmed. `items` are id-less rows produced by
 * `lib/goal-planner/scheduler.ts` and carried on the plan proposal's args
 * (`plan_items`). Every row starts `open`.
 */
async function writePlanItems(
  tx: any,
  schema: any,
  args: { userId: string; goalId: string; items: unknown },
): Promise<number> {
  const items = Array.isArray(args.items) ? args.items : []
  if (items.length === 0) return 0
  const HORIZONS = ['daily', 'weekly', 'monthly', 'quarterly', 'yearly']
  const rows: any[] = []
  for (const it of items) {
    if (!it || typeof it !== 'object') continue
    const horizon = (it as any).horizon
    if (typeof horizon !== 'string' || !HORIZONS.includes(horizon)) continue
    rows.push({
      id: newId('pi'),
      userId: args.userId,
      goalId: args.goalId,
      horizon,
      phase: typeof (it as any).phase === 'string' ? (it as any).phase : '',
      title: typeof (it as any).title === 'string' ? (it as any).title : '',
      note: typeof (it as any).note === 'string' ? (it as any).note : '',
      startDate: typeof (it as any).start_date === 'string' ? (it as any).start_date : null,
      endDate: typeof (it as any).end_date === 'string' ? (it as any).end_date : null,
      dueDate: typeof (it as any).due_date === 'string' ? (it as any).due_date : null,
      weeklyHours:
        typeof (it as any).weekly_hours === 'number' ? (it as any).weekly_hours : null,
      status: 'open',
    })
  }
  if (rows.length > 0) await tx.insert(schema.planItems).values(rows)
  return rows.length
}

/* -------------------------------------------------------------------------- */
/* Goal reference resolver                                                    */
/*                                                                             */
/* The system prompt (`lib/llm/prompts.ts`) advertises the goal reference     */
/* field as `goal_title` ("Reference existing goals by their exact current   */
/* title") — that mirrors the original Python prompt's phrasing and is the   */
/* only thing the model can actually emit, since it doesn't have goal IDs     */
/* in its context.                                                            */
/*                                                                             */
/* The original Python server fuzzy-matched by title; the new Postgres build   */
/* is keyed by ID (`y/db/schema.ts` every row has a stable `goal_xxx` ID).   */
/* This helper bridges the two: prefer `goal_id` when the caller supplies it */
/* (and verify ownership), otherwise look the goal up by exact title.        */
/* Returns `null` when neither resolves — callers translate that into a       */
/* "No matching goal" result, never a half-written row.                      */
/*                                                                             */
/* Title matching is exact-case-insensitive trimmed equality. The original   */
/* Python code did a fuzzy `re.search` which surfaced substring matches like  */
/* "Runn" → "Running"; we deliberately tighten this to avoid that class of   */
/* bug while still letting the LLM reference goals by their natural title.   */
/* -------------------------------------------------------------------------- */

// `resolveGoalRef` now lives in `lib/goal-drop.ts` so the executor, the
// DELETE /api/goals/[id] route, and the planner's drop-impact preview all
// resolve goals the exact same way. Imported at the top of this file.

/* -------------------------------------------------------------------------- */
/* Public entry point                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Apply a confirmed proposal to the database.
 *
 * Returns a human-readable `result` line. The function never throws on
 * business-logic failures (missing goal, etc.) — those are returned as
 * `success: false` with a `result` that names what went wrong, so the
 * caller can surface the message to the user without try/catch.
 *
 * Unknown `action` strings return `{ success: false, result: "Unknown
 * action '…'" }`. The route handler is expected to 502 in that case.
 */
export async function applyProposal(
  userId: string,
  proposal: Proposal
): Promise<ApplyProposalResult> {
  const { db, schema } = await getDbAndSchema()

  switch (proposal.action) {
    case 'create_goal':
      return applyCreateGoal(db, schema, userId, proposal)
    case 'update_goal':
      // Older prompts/clients may encode a pause/drop as `update_goal`.
      // Keep those transitions on the same shared side-effect path so a
      // status field can never bypass the drop cascade or capacity audit.
      if (proposal.args.status === 'dropped') {
        return applyDropGoal(db, schema, userId, proposal, 'confirm:drop_goal')
      }
      return applyUpdateGoal(db, schema, userId, proposal)
    case 'drop_goal':
      return applyDropGoal(db, schema, userId, proposal)
    case 'pause_goal':
      return applyStatusChange(db, schema, userId, proposal, 'paused', 'Paused')
    case 'set_goal_dates':
      return applySetGoalDates(db, schema, userId, proposal)
    case 'add_milestone':
      return applyAddMilestone(db, schema, userId, proposal)
    case 'add_blocker':
      return applyAddBlocker(db, schema, userId, proposal)
    case 'add_block':
      return applyAddTimetableBlock(db, schema, userId, proposal)
    case 'add_commitment':
      return applyAddCommitment(db, schema, userId, proposal)
    case 'complete_commitment':
      return applyCompleteCommitment(db, schema, userId, proposal)
    default:
      return { success: false, result: `Unknown action '${proposal.action}'` }
  }
}

/* -------------------------------------------------------------------------- */
/* Per-action implementations                                                  */
/*                                                                             */
/* Each is a self-contained `db.transaction(async (tx) => { … })` block. We   */
/* don't reuse a single transaction because each action is independent —      */
/* one failure should not roll back an earlier successful write from another  */
/* call to applyProposal.                                                     */
/* -------------------------------------------------------------------------- */

async function applyCreateGoal(
  db: any,
  schema: any,
  userId: string,
  proposal: Proposal
): Promise<ApplyProposalResult> {
  const args = proposal.args
  const title: string = args.title ?? 'Untitled goal'
  const horizon: Horizon = (HORIZONS as readonly string[]).includes(args.horizon)
    ? args.horizon
    : 'medium'
  const why: string = args.why ?? ''
  // The system prompt in `lib/llm/prompts.ts` advertises the field as
  // `first_action` (it reads naturally for new-goal prose), while the
  // original Python implementation stored it as `next_action`. The
  // DB column is `next_action`; accept either alias so a model that
  // follows the prompt literally doesn't silently lose the field.
  const nextAction: string =
    (typeof args.next_action === 'string' && args.next_action) ||
    (typeof args.first_action === 'string' && args.first_action) ||
    ''
  const startDate: string = args.start_date ?? todayIso()
  const targetDate: string | null = args.target_date ?? null

  // Iteration 10 (Goal Planner) — optional plan fields. The pipeline emits
  // these on create_goal; the legacy one-shot path omits them. Absent →
  // weekly_hours stays NULL (unestimated) and phase_objectives/life_area get
  // their schema defaults.
  const weeklyHours: number | null =
    typeof args.weekly_hours === 'number' && Number.isFinite(args.weekly_hours)
      ? Math.round(args.weekly_hours)
      : null
  const phaseObjectives: Record<string, string> =
    args.phase_objectives &&
    typeof args.phase_objectives === 'object' &&
    !Array.isArray(args.phase_objectives)
      ? (args.phase_objectives as Record<string, string>)
      : {}
  const lifeArea: string =
    typeof args.life_area === 'string' ? args.life_area : ''

  const goalId = newId('goal')

  await db.transaction(async (tx: any) => {
    await tx.insert(schema.goals).values({
      id: goalId,
      userId,
      title,
      horizon,
      why,
      nextAction,
      startDate,
      targetDate,
      weeklyHours,
      phaseObjectives,
      lifeArea,
      status: 'active',
    })
    const sourceIds = Array.isArray(args.source_ids)
      ? args.source_ids.filter((id: unknown): id is string => typeof id === 'string').slice(0, 10)
      : []
    if (sourceIds.length > 0) {
      await tx
        .update(schema.sources)
        .set({ goalId, goalTitle: title, expiresAt: null })
        .where(
          and(
            eq(schema.sources.userId, userId),
            eq(schema.sources.isDeleted, false),
            isNull(schema.sources.goalId),
            inArray(schema.sources.id, sourceIds),
          ),
        )
    }
    await tx.insert(schema.auditLog).values({
      id: newId('audit'),
      userId,
      type: `confirm:${proposal.action}`,
      summary: `Created goal '${title}' (${horizon})`,
      payload: { proposal_id: proposal.id, args },
    })
    await writePlanItems(tx, schema, { userId, goalId, items: args.plan_items })
  })

  return {
    success: true,
    result: `Created goal '${title}' (${horizon})`,
  }
}

async function applyUpdateGoal(
  db: any,
  schema: any,
  userId: string,
  proposal: Proposal
): Promise<ApplyProposalResult> {
  const args = proposal.args
  // Resolve the goal by `goal_id` first (fast path — the schema advertises
  // this) or `goal_title` (what the system prompt actually asks the model
  // to emit). Without this fallback `update_goal` returned "Missing
  // goal_id" for every real LLM response, which made the dashboard
  // look broken end-to-end.
  const ref = await resolveGoalRef(db, schema, userId, args)
  if (!ref) {
    return {
      success: false,
      result: `No matching goal for '${args.goal_id ?? args.goal_title ?? ''}'`,
    }
  }
  const goalId = ref.goalId

  const priorRows = await db
    .select({ status: schema.goals.status, weeklyHours: schema.goals.weeklyHours })
    .from(schema.goals)
    .where(and(eq(schema.goals.userId, userId), eq(schema.goals.id, goalId)))
    .limit(1)
  const freedWeeklyHours =
    args.status === 'paused' &&
    priorRows[0]?.status === 'active' &&
    typeof priorRows[0]?.weeklyHours === 'number'
      ? priorRows[0].weeklyHours
      : null

  const updates: Record<string, any> = { updatedAt: new Date() }
  if (typeof args.title === 'string' && args.title.length > 0) {
    updates.title = args.title
  }
  // The prompt's `update_goal` action accepts both `new_title` (rename)
  // and `title`. New title wins over plain title when both are present.
  if (typeof args.new_title === 'string' && args.new_title.length > 0) {
    updates.title = args.new_title
  }
  if (typeof args.why === 'string') {
    updates.why = args.why
  }
  if (typeof args.next_action === 'string') {
    updates.nextAction = args.next_action
  }
  if (
    typeof args.status === 'string' &&
    (GOAL_STATUSES as readonly string[]).includes(args.status)
  ) {
    updates.status = args.status as GoalStatus
  }
  if (typeof args.target_date === 'string') {
    updates.targetDate = args.target_date
  }
  // Iteration 10 — plan fields (optional).
  if (typeof args.weekly_hours === 'number' && Number.isFinite(args.weekly_hours)) {
    updates.weeklyHours = Math.round(args.weekly_hours)
  }
  if (
    args.phase_objectives &&
    typeof args.phase_objectives === 'object' &&
    !Array.isArray(args.phase_objectives)
  ) {
    updates.phaseObjectives = args.phase_objectives
  }
  if (typeof args.life_area === 'string') {
    updates.lifeArea = args.life_area
  }

  await db.transaction(async (tx: any) => {
    await tx.update(schema.goals).set(updates).where(eq(schema.goals.id, goalId))
    await tx.insert(schema.auditLog).values({
      id: newId('audit'),
      userId,
      type: `confirm:${proposal.action}`,
      summary: `Updated goal '${ref.goalTitle}'`,
      payload: {
        proposal_id: proposal.id,
        goal_id: goalId,
        goal_title: ref.goalTitle,
        freed_weekly_hours: freedWeeklyHours,
        args,
      },
    })
  })

  return {
    success: true,
    result: `Updated goal '${ref.goalTitle}'`,
  }
}

/**
 * Drop a goal — flip it to `dropped` AND cascade-clean its plan in one
 * transaction (close open commitments, delete milestones + scheduled
 * blocks, audit the counts). Delegates to `applyGoalDropCascade` so the
 * LLM confirm path and the direct DELETE route share one implementation.
 *
 * See `lib/goal-drop.ts` + memory/HLD-drop-goal-cascade.md.
 */
async function applyDropGoal(
  db: any,
  schema: any,
  userId: string,
  proposal: Proposal,
  auditType = `confirm:${proposal.action}`,
): Promise<ApplyProposalResult> {
  const ref = await resolveGoalRef(db, schema, userId, proposal.args)
  if (!ref) {
    return {
      success: false,
      result: `No matching goal for '${proposal.args.goal_id ?? proposal.args.goal_title ?? ''}'`,
    }
  }

  const { result } = await applyGoalDropCascade(db, schema, userId, ref, {
    auditType,
    reason:
      typeof proposal.args.reason === 'string' ? proposal.args.reason : undefined,
  })

  return { success: true, result }
}

/**
 * Shared implementation for pause_goal.
 *
 * Pause is deliberately NON-destructive (reversible), so it only flips
 * status + audits — it does NOT cascade. Drop uses `applyDropGoal` above.
 */
async function applyStatusChange(
  db: any,
  schema: any,
  userId: string,
  proposal: Proposal,
  newStatus: 'paused',
  verb: 'Paused'
): Promise<ApplyProposalResult> {
  // Same goal-reference resolution as `applyUpdateGoal` — see comment
  // there. Without it, "drop the swimming goal" silently returns
  // "Missing goal_id" because the LLM never sees goal IDs.
  const ref = await resolveGoalRef(db, schema, userId, proposal.args)
  if (!ref) {
    return {
      success: false,
      result: `No matching goal for '${proposal.args.goal_id ?? proposal.args.goal_title ?? ''}'`,
    }
  }
  const reason: string | undefined = proposal.args.reason
  const currentRows = await db
    .select({ status: schema.goals.status, weeklyHours: schema.goals.weeklyHours })
    .from(schema.goals)
    .where(and(eq(schema.goals.userId, userId), eq(schema.goals.id, ref.goalId)))
    .limit(1)
  const freedWeeklyHours =
    newStatus === 'paused' &&
    currentRows[0]?.status === 'active' &&
    typeof currentRows[0]?.weeklyHours === 'number'
      ? currentRows[0].weeklyHours
      : null

  await db.transaction(async (tx: any) => {
    await tx
      .update(schema.goals)
      .set({ status: newStatus, updatedAt: new Date() })
      .where(eq(schema.goals.id, ref.goalId))
    await tx.insert(schema.auditLog).values({
      id: newId('audit'),
      userId,
      type: `confirm:${proposal.action}`,
      summary: `${verb} goal '${ref.goalTitle}'${reason ? ` (${reason})` : ''}`,
      payload: {
        proposal_id: proposal.id,
        goal_id: ref.goalId,
        goal_title: ref.goalTitle,
        freed_weekly_hours: freedWeeklyHours,
        args: proposal.args,
      },
    })
  })

  return { success: true, result: `${verb} goal '${ref.goalTitle}'` }
}

async function applySetGoalDates(
  db: any,
  schema: any,
  userId: string,
  proposal: Proposal
): Promise<ApplyProposalResult> {
  const args = proposal.args
  // Same goal-reference resolution as the other actions.
  const ref = await resolveGoalRef(db, schema, userId, args)
  if (!ref) {
    return {
      success: false,
      result: `No matching goal for '${args.goal_id ?? args.goal_title ?? ''}'`,
    }
  }

  const updates: Record<string, any> = { updatedAt: new Date() }
  if (typeof args.start_date === 'string') updates.startDate = args.start_date
  if (typeof args.target_date === 'string') updates.targetDate = args.target_date
  if (updates.startDate === undefined && updates.targetDate === undefined) {
    return {
      success: false,
      result: `set_goal_dates requires start_date or target_date`,
    }
  }

  await db.transaction(async (tx: any) => {
    await tx.update(schema.goals).set(updates).where(eq(schema.goals.id, ref.goalId))
    await tx.insert(schema.auditLog).values({
      id: newId('audit'),
      userId,
      type: `confirm:${proposal.action}`,
      summary: `Timeline set for '${ref.goalTitle}': ${args.start_date ?? '?'} -> ${args.target_date ?? '?'}`,
      payload: {
        proposal_id: proposal.id,
        goal_id: ref.goalId,
        goal_title: ref.goalTitle,
        args,
      },
    })
  })

  return {
    success: true,
    result: `Timeline set for '${ref.goalTitle}': ${args.start_date ?? '?'} -> ${args.target_date ?? '?'}`,
  }
}

async function applyAddMilestone(
  db: any,
  schema: any,
  userId: string,
  proposal: Proposal
): Promise<ApplyProposalResult> {
  const args = proposal.args
  const title: string = args.title ?? ''
  const targetDate: string | null = args.target_date ?? null
  // Iteration 10 (Goal Planner) — phase name (key in goal.phase_objectives).
  const phase: string = typeof args.phase === 'string' ? args.phase : ''

  // Resolve the parent goal. Without this fallback, milestones created
  // by the LLM were inserted with `goalId=null, goalTitle=''` — they
  // persisted, but never rendered on the goal card / Timeline because
  // the dashboard joins them by `goal_id` (and falls back to title
  // only when both are non-empty). This was the headline bug: the
  // user reported "milestones aren't being created", but they were
  // being created — just orphaned.
  const ref = await resolveGoalRef(db, schema, userId, args)
  if (!ref) {
    return {
      success: false,
      result: `No matching goal for '${args.goal_id ?? args.goal_title ?? ''}'`,
    }
  }

  await db.transaction(async (tx: any) => {
    await tx.insert(schema.milestones).values({
      id: newId('mile'),
      userId,
      goalId: ref.goalId,
      goalTitle: ref.goalTitle,
      title,
      targetDate,
      phase,
      status: 'open',
    })
    await tx.insert(schema.auditLog).values({
      id: newId('audit'),
      userId,
      type: `confirm:${proposal.action}`,
      summary: `Milestone '${title}' -> ${ref.goalTitle}`,
      payload: { proposal_id: proposal.id, args },
    })
    await writePlanItems(tx, schema, { userId, goalId: ref.goalId, items: args.plan_items })
  })

  return {
    success: true,
    result: `Milestone '${title}' -> ${ref.goalTitle}`,
  }
}

async function applyAddBlocker(
  db: any,
  schema: any,
  userId: string,
  proposal: Proposal
): Promise<ApplyProposalResult> {
  const args = proposal.args
  const title: string = args.title ?? ''
  const startDate: string = args.start_date ?? todayIso()
  const endDate: string = args.end_date ?? startDate
  const note: string = args.note ?? ''

  await db.transaction(async (tx: any) => {
    await tx.insert(schema.blockers).values({
      id: newId('block'),
      userId,
      title,
      startDate,
      endDate,
      note,
    })
    await tx.insert(schema.auditLog).values({
      id: newId('audit'),
      userId,
      type: `confirm:${proposal.action}`,
      summary: `Blocker '${title}' ${startDate}..${endDate}`,
      payload: { proposal_id: proposal.id, args },
    })
  })

  return {
    success: true,
    result: `Blocker '${title}' ${startDate}..${endDate}`,
  }
}

async function applyAddTimetableBlock(
  db: any,
  schema: any,
  userId: string,
  proposal: Proposal,
): Promise<ApplyProposalResult> {
  const args = proposal.args
  const blockDate = typeof args.block_date === 'string' ? args.block_date : ''
  const startTime = typeof args.start_time === 'string' ? args.start_time : ''
  const endTime = typeof args.end_time === 'string' ? args.end_time : ''
  const label = typeof args.label === 'string' ? args.label.trim() : ''
  const kind = args.kind
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(blockDate) ||
    !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(startTime) ||
    !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(endTime) ||
    endTime <= startTime ||
    !label ||
    !['commitment', 'routine', 'blocker', 'focus'].includes(kind)
  ) {
    return { success: false, result: 'Invalid timetable block details.' }
  }

  let goalId: string | null = null
  let goalTitle = ''
  if (typeof args.goal_title === 'string' && args.goal_title.trim()) {
    const ref = await resolveGoalRef(db, schema, userId, args)
    if (!ref) {
      return { success: false, result: `No matching goal for '${args.goal_title}'` }
    }
    goalId = ref.goalId
    goalTitle = ref.goalTitle
  }

  await db.transaction(async (tx: any) => {
    await tx.insert(schema.timetableBlocks).values({
      id: newId('blk'),
      userId,
      blockDate,
      startTime,
      endTime,
      label,
      kind,
      source: 'plan',
      goalId,
      goalTitle,
      note: typeof args.note === 'string' ? args.note : '',
    })
    await tx.insert(schema.auditLog).values({
      id: newId('audit'),
      userId,
      type: `confirm:${proposal.action}`,
      summary: `Scheduled '${label}' ${blockDate} ${startTime}-${endTime}`,
      payload: { proposal_id: proposal.id, args },
    })
  })

  return {
    success: true,
    result: `Scheduled '${label}' ${blockDate} ${startTime}-${endTime}`,
  }
}

async function applyAddCommitment(
  db: any,
  schema: any,
  userId: string,
  proposal: Proposal
): Promise<ApplyProposalResult> {
  const args = proposal.args
  const text: string = args.text ?? ''
  const due: string | null = args.due ?? null
  // Iteration 10 (Goal Planner) — phase name (key in goal.phase_objectives).
  const phase: string = typeof args.phase === 'string' ? args.phase : ''

  // Resolve parent goal (id or title). Same orphan-prevention logic as
  // applyAddMilestone — without this, every commitment logged by the
  // model came back with `goal_title=''`, so it never appeared under
  // the goal card or on the timeline.
  let goalId: string | null = null
  let goalTitle: string = ''
  const ref = await resolveGoalRef(db, schema, userId, args)
  if (ref) {
    goalId = ref.goalId
    goalTitle = ref.goalTitle
  }

  await db.transaction(async (tx: any) => {
    await tx.insert(schema.commitments).values({
      id: newId('commit'),
      userId,
      goalId,
      goalTitle,
      text,
      due,
      phase,
      status: 'open',
    })
    await tx.insert(schema.auditLog).values({
      id: newId('audit'),
      userId,
      type: `confirm:${proposal.action}`,
      summary: `Committed: ${text}${goalTitle ? ` -> ${goalTitle}` : ''}`,
      payload: { proposal_id: proposal.id, args },
    })
    if (goalId) await writePlanItems(tx, schema, { userId, goalId, items: args.plan_items })
  })

  return {
    success: true,
    result: `Committed: ${text}${goalTitle ? ` -> ${goalTitle}` : ''}`,
  }
}

async function applyCompleteCommitment(
  db: any,
  schema: any,
  userId: string,
  proposal: Proposal
): Promise<ApplyProposalResult> {
  const args = proposal.args
  // The system prompt directs the model to identify a commitment by its
  // text (`{"action":"complete_commitment","text":"<commitment text>"}`)
  // — it doesn't have commitment IDs. Look up by id when present, else
  // resolve by exact text match against the user's open commitments.
  let commitmentId: string | undefined =
    typeof args.commitment_id === 'string' ? args.commitment_id : undefined

  const textRaw = typeof args.text === 'string' ? args.text.trim() : ''
  if (!commitmentId && textRaw) {
    const rows = await db
      .select({ id: schema.commitments.id, text: schema.commitments.text })
      .from(schema.commitments)
      .where(
        and(eq(schema.commitments.userId, userId), eq(schema.commitments.status, 'open'))
      )
      .limit(500)
    const needle = textRaw.toLowerCase()
    const exact = rows.find((r: { text: string }) => r.text.trim().toLowerCase() === needle)
    if (exact) commitmentId = exact.id
  }

  if (!commitmentId) {
    return {
      success: false,
      result: `No matching commitment for '${args.commitment_id ?? args.text ?? ''}'`,
    }
  }

  const rows = await db
    .select({ id: schema.commitments.id, text: schema.commitments.text })
    .from(schema.commitments)
    .where(
      and(
        eq(schema.commitments.userId, userId),
        eq(schema.commitments.id, commitmentId)
      )
    )
    .limit(1)
  if (!rows.length) {
    return {
      success: false,
      result: `No matching commitment for '${commitmentId}'`,
    }
  }
  const text = rows[0].text

  await db.transaction(async (tx: any) => {
    await tx
      .update(schema.commitments)
      .set({ status: 'done' })
      .where(eq(schema.commitments.id, commitmentId!))
    await tx.insert(schema.auditLog).values({
      id: newId('audit'),
      userId,
      type: `confirm:${proposal.action}`,
      summary: `Commitment '${text}' -> done`,
      payload: { proposal_id: proposal.id, args: proposal.args },
    })
  })

  return { success: true, result: `Commitment '${text}' -> done` }
}
