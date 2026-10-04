/**
 * /api/plan-items/[id] — update a persisted plan item (PATCH).
 *
 * The multi-horizon execution lattice (`plan_items`) is written by the proposal
 * executor on confirm. This route lets the user tick a task done/open — the
 * daily plan tasks and any other horizon item. Only `status` is editable.
 *
 * Auth via `authenticateRoute` (session or guest cookie); the row must belong
 * to the caller (404 otherwise). The auth choke-point invalidates the user's
 * dashboard cache on any mutation, so `/api/state` reflects the change.
 */

import { and, eq } from 'drizzle-orm'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'

import {
  authenticateRoute,
  badRequestResponse,
  notFoundResponse,
} from '@/lib/auth-route'
import { db } from '@/lib/db'
import { planItems } from '@/db/schema'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const PatchPlanItemBody = z.object({
  status: z.enum(['open', 'done']).optional(),
})

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await authenticateRoute(req)
  if (auth.error) return auth.error

  const { id } = await ctx.params
  if (!id) return badRequestResponse('Missing plan item id')

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return badRequestResponse('Invalid JSON body')
  }
  const parsed = PatchPlanItemBody.safeParse(body)
  if (!parsed.success) {
    return badRequestResponse(parsed.error.issues[0]?.message ?? 'Invalid body')
  }

  const existing = await db
    .select({ id: planItems.id })
    .from(planItems)
    .where(and(eq(planItems.id, id), eq(planItems.userId, auth.userId!)))
    .limit(1)
  if (!existing.length) return notFoundResponse('Plan item not found')

  if (parsed.data.status) {
    await db
      .update(planItems)
      .set({ status: parsed.data.status })
      .where(eq(planItems.id, id))
  }

  const row = await db.select().from(planItems).where(eq(planItems.id, id)).limit(1)
  return NextResponse.json({ plan_item: serialize(row[0]) })
}

function serialize(row: any) {
  return {
    id: row.id,
    goal_id: row.goalId,
    horizon: row.horizon,
    phase: row.phase,
    title: row.title,
    note: row.note,
    start_date: row.startDate,
    end_date: row.endDate,
    due_date: row.dueDate,
    weekly_hours: row.weeklyHours,
    status: row.status,
    created_at:
      row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
  }
}
