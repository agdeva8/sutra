/**
 * /api/timetable/[id] — PUT (replace) or DELETE a timetable block.
 *
 * Direct UI CRUD for an existing timetable block.
 *
 * PUT body (zod-validated; 400 on failure):
 *   {
 *     block_date: YYYY-MM-DD
 *     start_time: HH:MM
 *     end_time:   HH:MM
 *     label:      string
 *     kind?:      commitment|routine|blocker|focus
 *     goal_id?:   string | null
 *     note?:      string
 *   }
 *
 * Responses: 200 { block } on PUT, 200 { ok: true } on DELETE,
 * 400 invalid, 401 unauth, 404 not found / not owned.
 */
import { and, eq } from 'drizzle-orm'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'

import {
  authenticateRoute,
  badRequestResponse,
  notFoundResponse,
} from '@/lib/auth-route'
import { AUDIT_TYPES, writeAudit } from '@/lib/audit'
import { db } from '@/lib/db'
import { goals, timetableBlocks } from '@/db/schema'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/

const UpdateBlockBody = z.object({
  block_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  start_time: z.string().regex(TIME_RE),
  end_time: z.string().regex(TIME_RE),
  label: z.string().trim().min(1),
  kind: z.enum(['commitment', 'routine', 'blocker', 'focus']).optional().default('commitment'),
  goal_id: z.string().optional().nullable(),
  goal_title: z.string().optional().default(''),
  note: z.string().optional().default(''),
})

export async function PUT(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await authenticateRoute(req)
  if (auth.error) return auth.error

  const { id } = await ctx.params
  if (!id) return badRequestResponse('Missing block id')

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return badRequestResponse('Invalid JSON body')
  }

  const parsed = UpdateBlockBody.safeParse(body)
  if (!parsed.success) {
    return badRequestResponse(parsed.error.issues[0]?.message ?? 'Invalid body')
  }
  const input = parsed.data

  const existing = await db
    .select({ id: timetableBlocks.id, label: timetableBlocks.label })
    .from(timetableBlocks)
    .where(and(eq(timetableBlocks.id, id), eq(timetableBlocks.userId, auth.userId!)))
    .limit(1)
  if (!existing.length) return notFoundResponse('Block not found')

  let goalTitle = input.goal_title ?? ''
  const goalId = input.goal_id || null
  if (goalId && !goalTitle) {
    const g = await db
      .select({ title: goals.title })
      .from(goals)
      .where(and(eq(goals.id, goalId), eq(goals.userId, auth.userId!)))
      .limit(1)
    goalTitle = g[0]?.title ?? ''
  }

  await db.transaction(async (tx: any) => {
    await tx
      .update(timetableBlocks)
      .set({
        blockDate: input.block_date,
        startTime: input.start_time,
        endTime: input.end_time,
        label: input.label,
        kind: input.kind,
        goalId,
        goalTitle,
        note: input.note ?? '',
        updatedAt: new Date(),
      })
      .where(eq(timetableBlocks.id, id))
    await writeAudit(tx, {
      userId: auth.userId!,
      type: AUDIT_TYPES.UPDATE_TIMETABLE_BLOCK,
      summary: `Updated block '${existing[0].label}'`,
      payload: { block_id: id, ...input },
    })
  })

  const row = await db
    .select()
    .from(timetableBlocks)
    .where(eq(timetableBlocks.id, id))
    .limit(1)

  return NextResponse.json({ block: row[0] ? serialize(row[0]) : null })
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await authenticateRoute(req)
  if (auth.error) return auth.error

  const { id } = await ctx.params
  if (!id) return badRequestResponse('Missing block id')

  const existing = await db
    .select({ id: timetableBlocks.id, label: timetableBlocks.label })
    .from(timetableBlocks)
    .where(and(eq(timetableBlocks.id, id), eq(timetableBlocks.userId, auth.userId!)))
    .limit(1)
  if (!existing.length) return notFoundResponse('Block not found')

  await db.transaction(async (tx: any) => {
    await tx.delete(timetableBlocks).where(eq(timetableBlocks.id, id))
    await writeAudit(tx, {
      userId: auth.userId!,
      type: AUDIT_TYPES.DELETE_TIMETABLE_BLOCK,
      summary: `Deleted block '${existing[0].label}'`,
      payload: { block_id: id },
    })
  })

  return NextResponse.json({ ok: true })
}

function serialize(row: any) {
  const hhmm = (t: unknown) =>
    typeof t === 'string' && t.length >= 5 ? t.slice(0, 5) : t
  return {
    id: row.id,
    user_id: row.userId,
    block_date: row.blockDate,
    start_time: hhmm(row.startTime),
    end_time: hhmm(row.endTime),
    label: row.label,
    kind: row.kind,
    source: row.source,
    source_id: row.sourceId,
    goal_id: row.goalId,
    goal_title: row.goalTitle,
    note: row.note,
    created_at:
      row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
  }
}
