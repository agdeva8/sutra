import { NextRequest, NextResponse } from 'next/server'
import { and, asc, eq, isNull, lt } from 'drizzle-orm'

import { sources } from '@/db/schema'
import { db } from '@/lib/db'
import { invalidateUser } from '@/lib/cache'
import { deleteFile } from '@/lib/storage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const MAX_PER_RUN = 10
// ponytail: ten deletes cap one serverless run; shorten the schedule if backlog grows.

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ detail: 'Not found' }, { status: 404 })
  }

  const now = new Date()
  const expired = await db
    .select({
      id: sources.id,
      userId: sources.userId,
      storagePath: sources.storagePath,
      isDeleted: sources.isDeleted,
    })
    .from(sources)
    .where(and(lt(sources.expiresAt, now), isNull(sources.goalId)))
    .orderBy(asc(sources.expiresAt))
    .limit(MAX_PER_RUN)

  const results = await Promise.allSettled(
    expired.map(async (source) => {
      // Claim atomically so a concurrent goal confirmation can clear expiry
      // before storage is deleted. Soft-deleted expired rows are retryable.
      const claimed = source.isDeleted
        ? [source]
        : await db
            .update(sources)
            .set({ isDeleted: true })
            .where(
              and(
                eq(sources.id, source.id),
                eq(sources.isDeleted, false),
                isNull(sources.goalId),
                lt(sources.expiresAt, now),
              ),
            )
            .returning({ id: sources.id, userId: sources.userId, storagePath: sources.storagePath })
      if (!claimed.length) return false

      await deleteFile(claimed[0].storagePath)
      await db
        .delete(sources)
        .where(
          and(
            eq(sources.id, source.id),
            eq(sources.isDeleted, true),
            isNull(sources.goalId),
            lt(sources.expiresAt, now),
          ),
        )
      invalidateUser(source.userId)
      return true
    }),
  )

  return NextResponse.json({
    scanned: expired.length,
    deleted: results.filter((result) => result.status === 'fulfilled' && result.value).length,
    failed: results.filter((result) => result.status === 'rejected').length,
  })
}
