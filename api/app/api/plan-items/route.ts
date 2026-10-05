/**
 * /api/plan-items — create a user-defined daily task (POST).
 *
 * With commitments removed, a user adding an all-day "thing to do" from the
 * calendar becomes a `plan_items` row (horizon `daily`). This is scheduling
 * data the user owns directly (Hard constraint #2 — same bucket as blockers),
 * so there is no propose→confirm round-trip. The LLM still authors the plan's
 * own daily tasks during a (re)plan; this route is for manual adds/edits.
 */
import { type NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'

import { authenticateRoute, badRequestResponse } from '@/lib/auth-route'
import { db } from '@/lib/db'
import { planItems } from '@/db/schema'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
const CreateBody = z.object({
  title: z.string().trim().min(1),
  due_date: isoDate,
  goal_id: z.string().optional().nullable(),
  note: z.string().optional(),
})

export async function POST(req: NextRequest) {
  const auth = await authenticateRoute(req)
  if (auth.error) return auth.error
  if (!auth.userId) return badRequestResponse('Missing user')

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return badRequestResponse('Invalid JSON body')
  }
  const parsed = CreateBody.safeParse(body)
  if (!parsed.success) {
    return badRequestResponse(parsed.error.issues[0]?.message ?? 'Invalid body')
  }
  const { title, due_date, goal_id, note } = parsed.data

  const id = `pi_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`
  await db.insert(planItems).values({
    id,
    userId: auth.userId,
    goalId: goal_id || null,
    horizon: 'daily',
    phase: '',
    title,
    note: note ?? '',
    startDate: due_date,
    endDate: due_date,
    dueDate: due_date,
    weeklyHours: null,
    status: 'open',
  })

  return NextResponse.json({
    plan_item: {
      id,
      goal_id: goal_id || null,
      horizon: 'daily',
      phase: '',
      title,
      note: note ?? '',
      start_date: due_date,
      end_date: due_date,
      due_date,
      weekly_hours: null,
      status: 'open',
    },
  })
}
