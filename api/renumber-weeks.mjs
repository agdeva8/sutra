/**
 * Renumber weekly plan_items to be continuous across the whole plan
 * (Week 1..N). Previously the scheduler restarted at Week 1 per phase, which
 * read as "1,2,3, 1,2,3…" in the 3-month view. Idempotent.
 *
 * Usage: node renumber-weeks.mjs
 */
import { config as loadEnv } from 'dotenv'
loadEnv({ path: '.env' })
import { Client } from 'pg'

const url = process.env.DATABASE_URL || process.env.DATABASE_URL_UNPOOLED
if (!url) throw new Error('No DATABASE_URL')

const client = new Client({ connectionString: url })
await client.connect()
let updated = 0
try {
  const goals = await client.query("SELECT id FROM goals WHERE status <> 'dropped'")
  for (const g of goals.rows) {
    const weeks = await client.query(
      "SELECT id, title FROM plan_items WHERE goal_id=$1 AND horizon='weekly' ORDER BY start_date, created_at",
      [g.id],
    )
    let i = 0
    for (const w of weeks.rows) {
      i += 1
      const label = w.title.includes(' — ')
        ? w.title.split(' — ').slice(1).join(' — ')
        : w.title
      const next = `Week ${i} — ${label}`
      if (next !== w.title) {
        await client.query('UPDATE plan_items SET title=$1 WHERE id=$2', [next, w.id])
        updated++
      }
    }
  }
  console.log(`Renumbered ${updated} weekly rows.`)
} finally {
  await client.end()
}
