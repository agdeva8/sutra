/**
 * /api/goals/[id] — update (PATCH) or soft-delete (DELETE) a goal.
 *
 * Source of truth: backend/server.py:331-353 (`update_goal`/`drop_goal`)
 * + locked decision: goals are NEVER hard-deleted. DELETE here sets
 * `status = 'dropped'` and writes a `drop:goal` audit row.
 *
 * PATCH body — any subset of:
 *   { title?, why?, next_action?, horizon?, status?, target_date?,
 *     start_date? }
 *
 * Status must be one of 'active' | 'paused' | 'dropped'.
 * `horizon` must be one of the four horizon values.
 *
 * Auth: Auth.js session OR guest_token cookie.
 * Ownership: the row must exist AND belong to the authenticated user
 * (404 if missing OR not owned, so we don't leak the existence of other
 * users' rows).
 *
 * Responses:
 *   200 { goal } on PATCH success
 *   200 { ok: true } on DELETE success
 *   400 invalid body / status
 *   401 unauthenticated
 *   404 not found / not owned
 */

import { and, eq } from 'drizzle-orm'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'

import {
  authenticateRoute,
  badRequestResponse,
  notFoundResponse,
} from '@/lib/auth-route'
import { AUDIT_TYPES, asIsoDateOrNull, writeAudit } from '@/lib/audit'
import { db } from '@/lib/db'
import { applyGoalDropCascade } from '@/lib/goal-drop'
import {
  auditLog,
  goals,
  milestones,
  timetableBlocks,
  users,
} from '@/db/schema'

/** Schema bundle the shared drop cascade expects (`lib/goal-drop.ts`). */
const schema = { auditLog, goals, milestones, timetableBlocks, users }

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const HORIZONS = ['weekly', 'short', 'medium', 'long'] as const
const STATUSES = ['active', 'paused', 'dropped'] as const

const PatchGoalBody = z
  .object({
    title: z.string().trim().min(1).optional(),
    why: z.string().optional(),
    next_action: z.string().optional(),
    horizon: z.enum(HORIZONS).optional(),
    status: z.enum(STATUSES).optional(),
    start_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    target_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
  })
  .strict()

/* -------------------------------------------------------------------------- */
/* PATCH                                                                      */
/* -------------------------------------------------------------------------- */

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await authenticateRoute(req)
  if (auth.error) return auth.error

  const { id } = await ctx.params
  if (!id) return badRequestResponse('Missing goal id')

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return badRequestResponse('Invalid JSON body')
  }

  const parsed = PatchGoalBody.safeParse(body)
  if (!parsed.success) {
    return badRequestResponse(parsed.error.issues[0]?.message ?? 'Invalid body')
  }
  const input = parsed.data
  if (Object.keys(input).length === 0) {
    return badRequestResponse('No fields to update')
  }

  // Verify ownership first — single round-trip.
  const existing = await db
    .select({
      id: goals.id,
      title: goals.title,
      status: goals.status,
      weeklyHours: goals.weeklyHours,
    })
    .from(goals)
    .where(and(eq(goals.id, id), eq(goals.userId, auth.userId!)))
    .limit(1)

  if (!existing.length) {
    return notFoundResponse('Goal not found')
  }
  const existingTitle = existing[0].title

  // A status='dropped' PATCH is a full drop: cascade-clean the goal's plan
  // (commitments closed, milestones + scheduled blocks removed) rather than
  // flip the flag only. Any other field edits in the same body are
  // superseded by the drop.
  if (input.status === 'dropped') {
    await applyGoalDropCascade(
      db,
      schema,
      auth.userId!,
      { goalId: id, goalTitle: existingTitle },
      { auditType: AUDIT_TYPES.DROP_GOAL },
    )
    const dropped = await db
      .select()
      .from(goals)
      .where(eq(goals.id, id))
      .limit(1)
    return NextResponse.json({ goal: dropped[0] ? serialize(dropped[0]) : null })
  }

  // Translate snake_case JSON -> camelCase Drizzle columns.
  const updates: Record<string, any> = { updatedAt: new Date() }
  if (input.title !== undefined) updates.title = input.title
  if (input.why !== undefined) updates.why = input.why
  if (input.next_action !== undefined) updates.nextAction = input.next_action
  if (input.horizon !== undefined) updates.horizon = input.horizon
  if (input.status !== undefined) updates.status = input.status
  if (input.start_date !== undefined) updates.startDate = input.start_date
  if (input.target_date !== undefined) updates.targetDate = input.target_date

  await db.transaction(async (tx: any) => {
    await tx.update(goals).set(updates).where(eq(goals.id, id))
    await writeAudit(tx, {
      userId: auth.userId!,
      type:
        input.status === 'dropped'
          ? AUDIT_TYPES.DROP_GOAL
          : AUDIT_TYPES.UPDATE_GOAL,
      summary:
        input.status === 'dropped'
          ? `Dropped goal '${existingTitle}'`
          : input.status === 'paused'
            ? `Paused goal '${existingTitle}'`
            : `Updated goal '${existingTitle}'`,
      payload: {
        goal_id: id,
        goal_title: existingTitle,
        freed_weekly_hours:
          input.status === 'paused' &&
          existing[0].status === 'active' &&
          typeof existing[0].weeklyHours === 'number'
            ? existing[0].weeklyHours
            : null,
        fields: input,
      },
    })
  })

  const row = await db
    .select()
    .from(goals)
    .where(eq(goals.id, id))
    .limit(1)

  return NextResponse.json({ goal: row[0] ? serialize(row[0]) : null })
}

/* -------------------------------------------------------------------------- */
/* DELETE (soft)                                                              */
/* -------------------------------------------------------------------------- */

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await authenticateRoute(req)
  if (auth.error) return auth.error

  const { id } = await ctx.params
  if (!id) return badRequestResponse('Missing goal id')

  // Ownership pre-check.
  const existing = await db
    .select({ id: goals.id, title: goals.title })
    .from(goals)
    .where(and(eq(goals.id, id), eq(goals.userId, auth.userId!)))
    .limit(1)

  if (!existing.length) {
    return notFoundResponse('Goal not found')
  }

  await applyGoalDropCascade(
    db,
    schema,
    auth.userId!,
    { goalId: id, goalTitle: existing[0].title },
    { auditType: AUDIT_TYPES.DROP_GOAL },
  )

  return NextResponse.json({ ok: true })
}

function serialize(row: any) {
  return {
    id: row.id,
    user_id: row.userId,
    title: row.title,
    horizon: row.horizon,
    why: row.why,
    next_action: row.nextAction,
    start_date: row.startDate,
    target_date: row.targetDate,
    status: row.status,
    created_at:
      row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updated_at:
      row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
  }
}

void asIsoDateOrNull
