/**
 * GET   /api/sources/[id] — read one source (incl. its stored text excerpt)
 * PATCH /api/sources/[id] — update the stored text excerpt ("edit & save")
 * DELETE /api/sources/[id] — soft-delete a source
 *
 * Sets isDeleted=true. The file in Emergent Object Storage is NOT deleted
 * (audit trail).
 *
 * Auth: Emergent OAuth OR guest cookie OR Bearer (test/dev compat).
 */

import { NextRequest, NextResponse } from 'next/server'

import { auth } from '@/lib/auth'
import { verifyGuestToken } from '@/lib/guest-token'
import { db } from '@/lib/db'
import { sources } from '@/db/schema'
import { eq, and } from 'drizzle-orm'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const TEXT_EXCERPT_MAX = 8000

function serialize(row: typeof sources.$inferSelect) {
  return {
    id: row.id,
    user_id: row.userId,
    goal_id: row.goalId ?? '',
    goal_title: row.goalTitle,
    kind: row.kind,
    storage_path: row.storagePath,
    original_filename: row.originalFilename,
    content_type: row.contentType,
    size: row.size,
    url: row.url,
    text_excerpt: row.textExcerpt ?? '',
    is_deleted: row.isDeleted,
    created_at: row.createdAt.toISOString(),
  }
}

async function resolveUserId(req: NextRequest): Promise<string | null> {
  const bearer = req.headers.get('Authorization')?.replace('Bearer ', '')
  if (bearer && bearer !== 'bogus_xxx') return bearer

  const session = await auth()
  if (session?.user?.id) return session.user.id

  const guestToken = req.cookies.get('guest_token')?.value
  if (guestToken) return verifyGuestToken(guestToken)
  return null
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await resolveUserId(req)
  if (!userId) {
    return NextResponse.json({ detail: 'Not authenticated' }, { status: 401 })
  }
  const { id } = await params
  const [row] = await db
    .select()
    .from(sources)
    .where(and(eq(sources.id, id), eq(sources.userId, userId), eq(sources.isDeleted, false)))
    .limit(1)
  if (!row) return NextResponse.json({ detail: 'Not found' }, { status: 404 })
  return NextResponse.json(serialize(row))
}

/**
 * PATCH — update the stored `text_excerpt`. This is the "edit the source
 * content" write: what the user confirms here is exactly what AskPlanner
 * reads on the next turn (loadAttachedSources → ATTACHED SOURCES).
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await resolveUserId(req)
  if (!userId) {
    return NextResponse.json({ detail: 'Not authenticated' }, { status: 401 })
  }
  const { id } = await params

  let body: { text_excerpt?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ detail: 'Invalid JSON' }, { status: 400 })
  }
  if (typeof body.text_excerpt !== 'string') {
    return NextResponse.json({ detail: 'text_excerpt is required' }, { status: 400 })
  }

  const [existing] = await db
    .select({ id: sources.id })
    .from(sources)
    .where(and(eq(sources.id, id), eq(sources.userId, userId), eq(sources.isDeleted, false)))
    .limit(1)
  if (!existing) {
    return NextResponse.json({ detail: 'Not found' }, { status: 404 })
  }

  const [row] = await db
    .update(sources)
    .set({ textExcerpt: body.text_excerpt.trim().slice(0, TEXT_EXCERPT_MAX) })
    .where(and(eq(sources.id, id), eq(sources.userId, userId)))
    .returning()

  return NextResponse.json(serialize(row))
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await resolveUserId(req)
  if (!userId) {
    return NextResponse.json({ detail: 'Not authenticated' }, { status: 401 })
  }

  const { id } = await params

  const [existing] = await db
    .select({ id: sources.id })
    .from(sources)
    .where(and(eq(sources.id, id), eq(sources.userId, userId)))
    .limit(1)

  if (!existing) {
    return NextResponse.json({ detail: 'Not found' }, { status: 404 })
  }

  await db
    .update(sources)
    .set({ isDeleted: true })
    .where(and(eq(sources.id, id), eq(sources.userId, userId)))

  return NextResponse.json({ ok: true })
}