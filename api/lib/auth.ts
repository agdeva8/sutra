/**
 * Auth helpers for Sutra — Emergent-OAuth-only world.
 *
 * Source of truth: migration/discovery/03-nextjs-architecture.md
 * Section 3 (auth model) — after the Emergent swap.
 *
 * This file replaces the previous Auth.js v5 + Google wiring. The flow
 * is now:
 *
 *   1. User clicks "Sign in" in the header → browser is redirected to
 *      the Emergent OAuth host (see `lib/auth-actions.ts`).
 *   2. Emergent redirects back to `/auth/callback?session_id=…` (the
 *      legacy `/auth/callback` page handled this; the new client uses
 *      `/api/auth/session` POST to exchange the `session_id`).
 *   3. The Next.js `/api/auth/session` route calls
 *      `exchangeSessionId()` (from `lib/emergent/auth.ts`), upserts
 *      the `users` row, and writes an HttpOnly `session_token` cookie
 *      (7-day lifetime).
 *   4. Subsequent requests read the cookie via
 *      `getAuthenticatedUser()` here; route handlers use
 *      `authenticateRoute()` from `lib/auth-route.ts`.
 *
 * The `guest_token` cookie (10-min, locked decision #3) is retained
 * for anonymous users — that helper lives in `lib/guest-token.ts` and
 * is unchanged.
 *
 * Why server-only: reads `EMERGENT_LLM_KEY`, `INTEGRATION_PROXY_URL`,
 * and `AUTH_SECRET` via the boot validator. Never bundle this into a
 * client component.
 */

import 'server-only'

import { cookies } from 'next/headers'

import { eq } from 'drizzle-orm'

import { db } from '@/lib/db'
import { users } from '@/db/schema'
import { env } from '@/lib/env'
import {
  SESSION_TOKEN_COOKIE,
  clearSessionCookie,
} from '@/lib/emergent/auth'
import { verifyGuestToken, GUEST_TOKEN_COOKIE } from '@/lib/guest-token'

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export interface AuthUser {
  id: string
  email: string | null
  name: string | null
  image: string | null
  modelProvider: string
  isGuest: boolean
}

/* -------------------------------------------------------------------------- */
/* Internal: lazy DB + schema loaders                                         */
/*                                                                             */
/* We avoid importing `@/lib/db` / `@/db/schema` at module load so that     */
/* vitest can load this file without DATABASE_URL set. Routes import this    */
/* file lazily (after a cheap-token short-circuit) so the production boot    */
/* crash semantics in `lib/env.ts` still apply.                              */
/* -------------------------------------------------------------------------- */

async function loadUserRow(userId: string): Promise<AuthUser | null> {
  const { db } = await import('@/lib/db')
  const { users } = await import('@/db/schema')
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      image: users.image,
      modelProvider: users.modelProvider,
      isGuest: users.isGuest,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  return (rows[0] as AuthUser | undefined) ?? null
}

/* -------------------------------------------------------------------------- */
/* getAuthenticatedUser                                                       */
/*                                                                             */
/* Resolve the current user from cookies. Returns null when nothing valid  */
/* is present. Mirrors the legacy `auth()` shape so route handlers don't    */
/* need to be rewritten.                                                      */
/* -------------------------------------------------------------------------- */

export interface AuthContext {
  user: AuthUser
  /** 'session' = real OAuth user, 'guest' = anonymous, 'bearer' = legacy test token. */
  source: 'session' | 'guest' | 'bearer'
}

/**
 * Read cookies and resolve the current user (or null).
 *
 * Auth ladder:
 *   1. `session_token` cookie — Emergent OAuth (7-day lifetime). Loads
 *      the user row from the DB.
 *   2. `guest_token` cookie — anonymous 10-min cookie (HMAC-signed).
 *      Loads the user row from the DB.
 *
 * We intentionally do NOT accept the bare Bearer token here — that
 * path is reserved for route handlers that opt-in for backward-compat
 * with vitest fixtures (see `authenticateRoute`).
 */
export async function getAuthenticatedUser(): Promise<AuthContext | null> {
  const jar = await cookies()

  const sessionToken = jar.get(SESSION_TOKEN_COOKIE)?.value
  if (sessionToken && sessionToken.length > 0) {
    // We don't validate the session_token against the Emergent
    // proxy on every request — it carries an opaque handle and we
    // accept any non-empty value as valid (matches the Python
    // `get_current_user` semantics, which only checks the DB row).
    // To attach a session_token to a user we look up the most-recent
    // `user_sessions` row in the DB; if it doesn't exist we treat the
    // cookie as stale and fall through.
    const userId = await resolveSessionTokenUserId(sessionToken)
    if (userId) {
      const user = await loadUserRow(userId)
      if (user) return { user, source: 'session' }
    }
  }

  const guestToken = jar.get(GUEST_TOKEN_COOKIE)?.value
  const guestUserId = verifyGuestToken(guestToken)
  if (guestUserId) {
    const user = await loadUserRow(guestUserId)
    if (user) return { user, source: 'guest' }
  }

  return null
}

/* -------------------------------------------------------------------------- */
/* sessionToken → userId lookup                                                */
/*                                                                             */
/* We keep a small `user_sessions` table (mirroring the Python            */
/* `user_sessions` collection) so an Emergent-issued `session_token` can   */
/* be linked back to a goalcoach `user_id`. The Python upsert at          */
/* `backend/server.py:122-131` writes this row on sign-in; the `/api/auth/ */
/* session` route here does the same.                                        */
/* -------------------------------------------------------------------------- */

async function resolveSessionTokenUserId(sessionToken: string): Promise<string | null> {
  const { db } = await import('@/lib/db')
  const { sql } = await import('drizzle-orm')
  // Use a raw query — there's no typed schema for `user_sessions` in
  // the current Drizzle setup (the Python collection was retired in
  // the Phase 1 cutover). We treat the cookie as stale when no row
  // matches.
  const result = await db.execute(
    sql`SELECT user_id, expires_at FROM user_sessions WHERE session_token = ${sessionToken} LIMIT 1`,
  )
  // Result shape differs by driver: pg Pool gives { rows, ... }, neon gives direct array
  const rawResult = result as unknown as { rows?: Array<{ user_id: string; expires_at: string | Date | null }> } | Array<{ user_id: string; expires_at: string | Date | null }>
  const rows = Array.isArray(rawResult) ? rawResult : (rawResult.rows ?? [])
  const row = rows[0]
  if (!row) return null
  const exp = row.expires_at
  const expNum = exp instanceof Date ? exp.getTime() : exp ? new Date(exp).getTime() : 0
  if (expNum <= Date.now()) return null
  return row.user_id
}

/* -------------------------------------------------------------------------- */
/* Upsert helpers — called from /api/auth/session after the Emergent exchange */
/* -------------------------------------------------------------------------- */

/**
 * Upsert a user row + write the `user_sessions` row that links the
 * `session_token` cookie to the user id. Mirrors
 * `backend/server.py:99-131`.
 */
export async function upsertUserFromSession(args: {
  email: string
  name: string | null
  picture: string | null
  sessionToken: string
}): Promise<AuthUser> {
  const { db } = await import('@/lib/db')
  const { users } = await import('@/db/schema')
  const { sql } = await import('drizzle-orm')
  const { newId } = await import('@/lib/ids')

  // 1) Find existing user by email (or create a new one).
  const existing = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      image: users.image,
      modelProvider: users.modelProvider,
      isGuest: users.isGuest,
    })
    .from(users)
    .where(eq(users.email, args.email))
    .limit(1)

  let userId: string
  if (existing[0]) {
    userId = existing[0].id
    await db
      .update(users)
      .set({ name: args.name, image: args.picture })
      .where(eq(users.id, userId))
  } else {
    userId = newId('user')
    await db.insert(users).values({
      id: userId,
      email: args.email,
      name: args.name,
      image: args.picture,
      emailVerified: null,
      isGuest: false,
      modelProvider: 'gemini',
    })
  }

  // 2) Upsert the user_sessions row. 7-day expiry.
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
  await db.execute(sql`
    INSERT INTO user_sessions (session_token, user_id, expires_at, created_at)
    VALUES (${args.sessionToken}, ${userId}, ${expiresAt.toISOString()}, NOW())
    ON CONFLICT (session_token) DO UPDATE SET
      user_id = EXCLUDED.user_id,
      expires_at = EXCLUDED.expires_at
  `)

  // 3) Migrate any anonymous guest rows to this user.
  await migrateGuestRowsToUser(userId)

  const loaded = await loadUserRow(userId)
  if (!loaded) {
    throw new Error('Failed to load user row after upsert')
  }
  return loaded
}

async function migrateGuestRowsToUser(userId: string): Promise<void> {
  const jar = await cookies()
  const guestToken = jar.get(GUEST_TOKEN_COOKIE)?.value
  if (!guestToken) return
  const guestUserId = verifyGuestToken(guestToken)
  if (!guestUserId || guestUserId === userId) return
  // Reassign every child row that belonged to the guest.
  const { db } = await import('@/lib/db')
  const { sql } = await import('drizzle-orm')
  // Skip any table a later migration dropped (0013 removed `commitments`).
  // A stale entry here used to throw `relation "commitments" does not exist`
  // and 500 the whole login, so resolve the list against the live schema.
  const tables = ['goals', 'commitments', 'milestones', 'blockers', 'messages', 'audit_log', 'sources', 'state_overrides']
  const tablesResult = await db.execute(
    sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
  )
  // Result shape differs by driver: pg Pool gives { rows, ... }, neon gives direct array.
  const rawTables = tablesResult as unknown as { rows?: Array<{ table_name: string }> } | Array<{ table_name: string }>
  const tableRows = Array.isArray(rawTables) ? rawTables : (rawTables.rows ?? [])
  const existingTables = new Set(tableRows.map((r) => r.table_name))
  for (const t of tables) {
    if (!existingTables.has(t)) continue
    await db.execute(
      sql.raw(
        `UPDATE ${t} SET user_id = '${userId.replace(/'/g, "''")}' WHERE user_id = '${guestUserId.replace(/'/g, "''")}'`,
      ),
    )
  }
  await db.execute(
    sql`DELETE FROM users WHERE id = ${guestUserId} AND is_guest = TRUE`,
  )
  await db.execute(
    sql`DELETE FROM user_sessions WHERE user_id = ${guestUserId}`,
  )
  jar.set({
    name: GUEST_TOKEN_COOKIE,
    value: '',
    maxAge: 0,
    path: '/',
  })
}

/* -------------------------------------------------------------------------- */
/* signOut — clears the session cookie + the `user_sessions` row             */
/* -------------------------------------------------------------------------- */

export async function signOut(): Promise<void> {
  const jar = await cookies()
  const sessionToken = jar.get(SESSION_TOKEN_COOKIE)?.value
  if (sessionToken) {
    try {
      const { db } = await import('@/lib/db')
      const { sql } = await import('drizzle-orm')
      await db.execute(
        sql`DELETE FROM user_sessions WHERE session_token = ${sessionToken}`,
      )
    } catch {
      /* best-effort */
    }
  }
  await clearSessionCookie()
}

/* -------------------------------------------------------------------------- */
/* Compatibility shims                                                        */
/*                                                                             */
/* The legacy `auth.ts` exported `auth`, `signIn`, `signOut`, and           */
/* `handlers`. Route imports like `import { auth } from '@/lib/auth'` are  */
/* widely used; we keep them here as thin wrappers so we don't have to    */
/* rewrite every call site.                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Legacy `auth()` — returns the current session-shaped object, or null.
 * Drop-in for the previous Auth.js API.
 */
export async function auth(): Promise<{
  user: {
    id: string
    email: string | null
    name: string | null
    image: string | null
    isGuest: boolean
    modelProvider: string
  }
} | null> {
  const ctx = await getAuthenticatedUser()
  if (!ctx) return null
  return { user: ctx.user }
}

/* Re-exports so legacy callers still resolve. */
export { SESSION_TOKEN_COOKIE }

/** Used by the Auth.js catch-all route — now just no-ops that return 404. */
export async function handlers(): Promise<never> {
  throw new Error(
    'Auth.js handlers are no longer used; the Emergent OAuth flow replaces them.',
  )
}

// Surface a deliberate reference to the env validator so anything that
// imports this module triggers the boot crash if env is missing — but
// only on first import in a server context.
void env