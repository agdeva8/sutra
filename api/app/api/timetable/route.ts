/**
 * /api/timetable — POST (create) and GET (list) the user's timetable blocks.
 *
 * Manual timetable CRUD. The coach's plan_day action uses the standard
 * proposal -> user-confirm flow; this route remains the direct UI path.
 *
 * Table: `timetable_blocks` (see db/schema.ts). Created by migration
 * 0006_timetable_blocks.sql.
 *
 * POST body (zod-validated; 400 on failure):
 *   {
 *     block_date: YYYY-MM-DD                 // required
 *     start_time: HH:MM / HH:MM:SS           // required
 *     end_time:   HH:MM / HH:MM:SS           // required
 *     label:      string                     // required
 *     kind?:      commitment|routine|blocker|focus   // default commitment
 *     goal_id?:   string                     // optional goal link
 *     note?:      string                     // default ''
 *   }
 *
 * GET response: { blocks: [...] } ordered by date then start_time.
 *
 * Auth: Auth.js session OR guest_token cookie.
 */
import { and, asc, eq } from 'drizzle-orm'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'

import {
  authenticateRoute,
  badRequestResponse,
} from '@/lib/auth-route'
import { AUDIT_TYPES, newId, writeAudit } from '@/lib/audit'
import { cachedGet } from '@/lib/cache'
import { db } from '@/lib/db'
import { goals, timetableBlocks } from '@/db/schema'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/

const CreateBlockBody = z.object({
  block_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'block_date must be YYYY-MM-DD'),
  start_time: z.string().regex(TIME_RE, 'start_time must be HH:MM'),
  end_time: z.string().regex(TIME_RE, 'end_time must be HH:MM'),
  label: z.string().trim().min(1, 'label is required'),
  kind: z.enum(['commitment', 'routine', 'blocker', 'focus']).optional().default('commitment'),
  goal_id: z.string().optional().nullable(),
  goal_title: z.string().optional().default(''),
  note: z.string().optional().default(''),
})

/* -------------------------------------------------------------------------- */
/* POST                                                                       */
/* -------------------------------------------------------------------------- */

export async function POST(req: NextRequest) {
  const auth = await authenticateRoute(req)
  if (auth.error) return auth.error

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return badRequestResponse('Invalid JSON body')
  }

  const parsed = CreateBlockBody.safeParse(body)
  if (!parsed.success) {
    return badRequestResponse(parsed.error.issues[0]?.message ?? 'Invalid body')
  }
  const input = parsed.data

  // Resolve the goal title server-side when a goal_id is supplied so the
  // row carries a readable label even if the goal is later renamed/dropped.
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

  const id = newId('blk')

  await db.transaction(async (tx: any) => {
    await tx.insert(timetableBlocks).values({
      id,
      userId: auth.userId!,
      blockDate: input.block_date,
      startTime: input.start_time,
      endTime: input.end_time,
      label: input.label,
      kind: input.kind,
      source: 'manual',
      goalId,
      goalTitle,
      note: input.note ?? '',
    })
    await writeAudit(tx, {
      userId: auth.userId!,
      type: AUDIT_TYPES.CREATE_TIMETABLE_BLOCK,
      summary: `Added '${input.label}' ${input.block_date} ${input.start_time}-${input.end_time}`,
      payload: { block_id: id, ...input },
    })
  })

  const row = await db
    .select()
    .from(timetableBlocks)
    .where(eq(timetableBlocks.id, id))
    .limit(1)

  return NextResponse.json(row[0] ? serialize(row[0]) : { id }, { status: 201 })
}

/* -------------------------------------------------------------------------- */
/* GET                                                                        */
/* -------------------------------------------------------------------------- */

export const GET = cachedGet('timetable', async (userId) => {
  const rows = await db
    .select()
    .from(timetableBlocks)
    .where(eq(timetableBlocks.userId, userId))
    .orderBy(asc(timetableBlocks.blockDate), asc(timetableBlocks.startTime))
    .limit(1000)

  return { blocks: rows.map(serialize) }
})

function serialize(row: any) {
  // `time` columns come back as strings like '09:00:00'; trim to HH:MM
  // for the client so the <input type="time"> value matches.
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
