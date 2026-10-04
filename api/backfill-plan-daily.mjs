/**
 * Backfill: derive per-day plan tasks for EXISTING plans.
 *
 * The scheduler now emits one `plan_items` daily row per calendar day in each
 * weekly band, but goals planned before that change have only weekly rows.
 * This one-off script derives + inserts the missing daily rows, exactly the
 * way `scheduler.ts` does, so the calendar/day view shows them. Idempotent:
 * it skips a day that already has a daily plan task (weekly_hours NOT NULL).
 *
 * Usage: node backfill-plan-daily.mjs
 */
import { config as loadEnv } from 'dotenv'
loadEnv({ path: '.env' })
import { randomUUID } from 'node:crypto'
import { Client } from 'pg'

const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL
if (!url) throw new Error('No DATABASE_URL')

const iso = (d) => {
  const x = d instanceof Date ? d : new Date(d)
  return x.toISOString().slice(0, 10)
}
const addDays = (isoStr, n) => {
  const d = new Date(`${isoStr}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const daysBetween = (a, b) =>
  Math.round(
    (Date.parse(`${b}T00:00:00.000Z`) - Date.parse(`${a}T00:00:00.000Z`)) / 86400000,
  )

const newId = (p) => `${p}_${randomUUID().replace(/-/g, '').slice(0, 12)}`

const client = new Client({ connectionString: url })
await client.connect()
try {
  const goals = await client.query(
    "SELECT id, user_id FROM goals WHERE status <> 'dropped'",
  )
  let inserted = 0
  for (const g of goals.rows) {
    const weekly = await client.query(
      "SELECT phase, title, start_date, end_date, weekly_hours FROM plan_items WHERE goal_id=$1 AND horizon='weekly' ORDER BY start_date",
      [g.id],
    )
    for (const w of weekly.rows) {
      if (!w.start_date || !w.end_date) continue
      const bandStart = iso(w.start_date)
      const bandEnd = iso(w.end_date)
      const label = w.title.includes(' — ')
        ? w.title.split(' — ').slice(1).join(' — ')
        : w.title
      const days = daysBetween(bandStart, bandEnd) + 1
      const perDay =
        w.weekly_hours != null && days > 0
          ? Math.max(0.5, Math.round((w.weekly_hours / days) * 10) / 10)
          : null
      for (let d = 0; d < days; d++) {
        const day = addDays(bandStart, d)
        const exists = await client.query(
          "SELECT 1 FROM plan_items WHERE goal_id=$1 AND horizon='daily' AND due_date=$2 AND note LIKE 'Fulfils%' LIMIT 1",
          [g.id, day],
        )
        if (exists.rowCount > 0) continue
        await client.query(
          `INSERT INTO plan_items (id, user_id, goal_id, horizon, phase, title, note, start_date, end_date, due_date, weekly_hours, status)
           VALUES ($1,$2,$3,'daily',$4,$5,$6,$7,$8,$7,NULL,'open')`,
          [
            newId('pi'),
            g.user_id,
            g.id,
            w.phase,
            label,
            perDay != null ? `Fulfils “${label}” · ${perDay}h` : `Fulfils “${label}”`,
            day,
            day,
          ],
        )
        inserted++
      }
    }
  }
  console.log(`Backfill done. Inserted ${inserted} daily plan tasks.`)
} finally {
  await client.end()
}
