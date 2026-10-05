/**
 * GET /api/audit/export — JSON file dump of all user messages + audit events.
 *
 * Sets Content-Disposition: attachment so the browser downloads a .json file.
 *
 * Used by the Honesty Audit UI ("what has the coach done on my behalf?").
 *
 * Auth: Phase-0 unified resolver — Bearer header → session_token cookie
 * (dev-login + Auth.js) → Emergent OAuth session → guest_token cookie.
 * Never includes secrets (session_token values, etc.) — only
 * user-visible data.
 */

import { eq } from 'drizzle-orm'
import { NextRequest, NextResponse } from 'next/server'

import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { auditLog, goals, messages, users } from '@/db/schema'
import { GUEST_TOKEN_COOKIE, verifyGuestToken } from '@/lib/guest-token'
import { resolveRequestUser } from '@/lib/request-user'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Read the current authenticated user, regardless of source. The
 * previous helper only read OAuth + guest cookie, so a user signed in
 * via dev-login (session_token) would either 401 or, if a stale
 * guest_token happened to be on the wire, silently return the guest's
 * data — a real cross-user data leak. The Phase-0 unified resolver
 * `resolveRequestUser` reads every cookie path consistently and
 * closes that hole.
 */
async function getUserIdAndEmail(
  req: NextRequest
): Promise<{ userId: string; email: string | null; name: string | null } | null> {
  const resolved = await resolveRequestUser(req).catch(() => null)
  if (resolved?.userId) {
    const row = await db
      .select({ id: users.id, email: users.email, name: users.name })
      .from(users)
      .where(eq(users.id, resolved.userId))
      .limit(1)
    if (row[0]) {
      return { userId: row[0].id, email: row[0].email ?? null, name: row[0].name ?? null }
    }
    return null
  }

  const session = await auth()
  if (session?.user?.id) {
    const row = await db
      .select({ id: users.id, email: users.email, name: users.name })
      .from(users)
      .where(eq(users.id, session.user.id))
      .limit(1)
    if (row[0]) {
      return { userId: row[0].id, email: row[0].email ?? null, name: row[0].name ?? null }
    }
    return null
  }

  const token = req.cookies.get(GUEST_TOKEN_COOKIE)?.value
  const guestUserId = verifyGuestToken(token)
  if (guestUserId) {
    const row = await db
      .select({ id: users.id, email: users.email, name: users.name })
      .from(users)
      .where(eq(users.id, guestUserId))
      .limit(1)
    const user = row[0]
    if (!user) return null
    return { userId: user.id, email: user.email ?? null, name: user.name ?? null }
  }

  return null
}

export async function GET(req: NextRequest) {
  const user = await getUserIdAndEmail(req)
  if (!user) {
    return NextResponse.json({ detail: 'Not authenticated' }, { status: 401 })
  }

  const { userId, email, name } = user

  // Fetch all user data in parallel.
  const [auditRows, messageRows, goalRows] = await Promise.all([
    db
      .select()
      .from(auditLog)
      .where(eq(auditLog.userId, userId))
      .orderBy(auditLog.createdAt),
    db
      .select()
      .from(messages)
      .where(eq(messages.userId, userId))
      .orderBy(messages.createdAt),
    db
      .select()
      .from(goals)
      .where(eq(goals.userId, userId))
      .orderBy(goals.createdAt),
  ])

  // Map to the legacy FastAPI response shape (snake_case keys).
  const audit_log = auditRows.map((r) => ({
    id: r.id,
    user_id: r.userId,
    type: r.type,
    summary: r.summary,
    payload: r.payload,
    created_at: r.createdAt.toISOString(),
  }))

  const conversation = messageRows.map((r) => ({
    id: r.id,
    user_id: r.userId,
    role: r.role,
    content: r.content,
    provider: r.provider,
    created_at: r.createdAt.toISOString(),
  }))

  const exportedAt = new Date().toISOString()
  const filename = `sutra-export-${userId}-${exportedAt.slice(0, 10)}.json`

  const payload = {
    exported_at: exportedAt,
    user: { email, name },
    state: {
      goals: goalRows.map((g) => ({
        id: g.id,
        title: g.title,
        horizon: g.horizon,
        status: g.status,
        created_at: g.createdAt.toISOString(),
      })),
    },
    conversation,
    audit_log,
  }

  return NextResponse.json(payload, {
    headers: {
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
}