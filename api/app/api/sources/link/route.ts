/**
 * POST /api/sources/link — record a URL as a source
 *
 * Body: { url: string; goal_id?: string; title?: string }
 *
 * Auth: Emergent OAuth OR guest cookie OR Bearer (test/dev compat).
 */

import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'

import { auth } from '@/lib/auth'
import { verifyGuestToken } from '@/lib/guest-token'
import { db } from '@/lib/db'
import { sources, goals } from '@/db/schema'
import { eq, and } from 'drizzle-orm'
import { fetchLinkText } from '@/lib/sources'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function resolveUserId(req: NextRequest): Promise<string | null> {
  const { resolveRequestUser } = await import('@/lib/request-user')
  const caller = await resolveRequestUser(req)
  return caller?.userId ?? null
}

export async function POST(req: NextRequest) {
  const userId = await resolveUserId(req)
  if (!userId) {
    return NextResponse.json({ detail: 'Not authenticated' }, { status: 401 })
  }

  let body: { url?: string; goal_id?: string; title?: string; temporary?: boolean }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ detail: 'Invalid JSON' }, { status: 400 })
  }

  const url = body.url?.trim()
  if (!url) {
    return NextResponse.json({ detail: 'url is required' }, { status: 400 })
  }

  // Basic URL sanity check
  try {
    new URL(url)
  } catch {
    return NextResponse.json({ detail: 'Invalid URL' }, { status: 400 })
  }

  const goalId = body.goal_id?.trim() ?? ''

  // P1 security: goal ownership must be enforced. Reject unowned
  // goalIds with 404 instead of silently dropping the title and
  // keeping the id (which would let any caller attach a source to
  // any other user's goal by guessing its id).
  let resolvedGoalId: string | null = null
  let goalTitle = ''
  if (goalId) {
    const [goalRow] = await db
      .select({ id: goals.id, title: goals.title })
      .from(goals)
      .where(and(eq(goals.id, goalId), eq(goals.userId, userId)))
      .limit(1)
    if (!goalRow) {
      return NextResponse.json(
        { detail: 'Goal not found' },
        { status: 404 },
      )
    }
    resolvedGoalId = goalRow.id
    goalTitle = goalRow.title
  }

  // Fetch and extract link text
  const textExcerpt = await fetchLinkText(url)

  const id = `src_${randomUUID().replace(/-/g, '').slice(0, 12)}`
  const originalFilename = body.title?.trim() || url

  const [row] = await db
    .insert(sources)
    .values({
      id,
      userId,
      goalId: resolvedGoalId,
      goalTitle,
      kind: 'link',
      storagePath: '',
      originalFilename,
      contentType: 'text/uri-list',
      size: 0,
      url,
      textExcerpt,
      isDeleted: false,
      expiresAt:
        body.temporary === true && !resolvedGoalId
          ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
          : null,
    })
    .returning()

  return NextResponse.json({
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
    is_deleted: row.isDeleted,
    created_at: row.createdAt.toISOString(),
  })
}
