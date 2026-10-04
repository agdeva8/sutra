/**
 * Drizzle client for Sutra.
 *
 * Modified to exclusively use the standard `pg` driver to connect to
 * Supabase or any standard Postgres provider.
 */

import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'

import { env } from '@/lib/env'
import * as schema from '@/db/schema'

export type DbDriver = 'pg'

function buildDb() {
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    // Fail fast instead of queueing on a wedged pool forever. The Supabase
    // pooler is long-haul from dev machines; a dead connection used to leave
    // new queries waiting indefinitely (and pool connection errors printed as
    // uncaughtException). 10s is well above healthy-link query time.
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  })
  // pg requires a pool-level error handler — without it, a background
  // connection failure (e.g. EADDRNOTAVAIL after a network flap) surfaces as
  // an uncaughtException instead of a route error.
  pool.on('error', () => undefined)
  return { db: drizzle(pool, { schema, casing: 'snake_case' }), driver: 'pg' as const }
}

const built = buildDb()

/** Drizzle ORM client. Use this everywhere — never instantiate another. */
export const db = built.db

/** The driver this client was built with, for telemetry / health checks. */
export const dbDriver: DbDriver = built.driver

export { schema }

/**
 * Close the underlying connection pool.
 *
 * We end the underlying Pool so the script can exit cleanly without 
 * "unclean disconnect" warnings in Postgres logs. Call from scripts 
 * at shutdown; in the Next.js runtime the process lifetime owns the 
 * pool and you generally don't need this.
 */
export async function closeDb(): Promise<void> {
  const client = (db as any).$client
  if (client && typeof client.end === 'function') {
    await client.end()
  }
}
