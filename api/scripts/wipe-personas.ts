#!/usr/bin/env tsx
/**
 * Dev-only — wipe the six seeded personas + every guest, so they can be
 * re-created on the current engine.
 *
 * Narrower than `reset-dev-data.ts` (which also deletes extra stray
 * accounts and rebuilds `user_founder01` line-by-line): this deletes
 * EXACTLY
 *   1. the six curated personas — `persona_key IS NOT NULL`
 *      (founder, starter, overdue, dormant, dense, memory_heavy), and
 *   2. every `is_guest = true` row.
 * Everything else — the real account, and the assorted non-guest test
 * identities — is left untouched.
 *
 * The planner's LangGraph checkpoints (checkpoints / checkpoint_blobs /
 * checkpoint_writes) are keyed by conversation id with NO FK, so they are
 * cleared explicitly first, before the conversations cascade away. Then a
 * single `DELETE FROM users` removes the rest through ON DELETE CASCADE.
 *
 * Hard-gated on `ALLOW_DEV_LOGIN=true`. Dry-run by default; pass
 * `--confirm` to apply.
 *
 * Usage:
 *   pnpm tsx scripts/wipe-personas.ts            # dry run
 *   pnpm tsx scripts/wipe-personas.ts --confirm  # wipe
 *   ... then: pnpm tsx scripts/seed-personas.ts
 */

import 'dotenv/config'

import pg from 'pg'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  console.error('[wipe] DATABASE_URL is not set. Aborting.')
  process.exit(2)
}
if (process.env.ALLOW_DEV_LOGIN !== 'true') {
  console.error('[wipe] ALLOW_DEV_LOGIN must be "true". Aborting.')
  process.exit(2)
}

const { Pool } = pg
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } })

const TARGET_WHERE = `(persona_key IS NOT NULL OR is_guest = true)`

async function report(label: string): Promise<void> {
  const users = await pool.query<{ id: string; name: string | null; persona_key: string | null; is_guest: boolean }>(
    `SELECT id, name, persona_key, is_guest FROM users WHERE ${TARGET_WHERE} ORDER BY persona_weight, created_at`,
  )
  const goals = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM goals WHERE user_id IN (SELECT id FROM users WHERE ${TARGET_WHERE})`,
  )
  console.log(`[wipe] ${label}: ${users.rows.length} user(s), ${goals.rows[0].n} goal(s)`)
  for (const u of users.rows) {
    console.log(
      `   ${u.persona_key ? 'persona' : 'guest  '} ${u.id}  name="${u.name ?? ''}"`,
    )
  }
}

async function wipe(): Promise<void> {
  console.log('[wipe] clearing orphaned planner checkpoints...')
  const convos = await pool.query<{ id: string }>(
    `SELECT id FROM conversations WHERE user_id IN (SELECT id FROM users WHERE ${TARGET_WHERE})`,
  )
  const ids = convos.rows.map((r) => `'${r.id.replace(/'/g, "''")}'`).join(',')
  if (ids.length > 0) {
    for (const table of ['checkpoints', 'checkpoint_blobs', 'checkpoint_writes']) {
      const exists = await pool.query<{ ok: boolean }>(
        `SELECT to_regclass('public.' || $1) IS NOT NULL AS ok`,
        [table],
      )
      if (exists.rows[0]?.ok) {
        await pool.query(`DELETE FROM ${table} WHERE thread_id IN (${ids})`)
      }
    }
  }

  console.log('[wipe] deleting persona + guest users (children cascade)...')
  const res = await pool.query(`DELETE FROM users WHERE ${TARGET_WHERE}`)
  console.log(`[wipe] deleted ${res.rowCount} user row(s).`)
}

async function main(): Promise<void> {
  const confirm = process.argv.includes('--confirm')
  await report('targets')
  if (!confirm) {
    console.log('[wipe] DRY RUN — pass --confirm to apply.')
    await pool.end()
    return
  }
  await wipe()
  await report('after')
  console.log('[wipe] done. Now run: pnpm tsx scripts/seed-personas.ts')
  await pool.end()
}

main().catch(async (e) => {
  console.error('[wipe] FATAL', e)
  await pool.end().catch(() => {})
  process.exit(1)
})
