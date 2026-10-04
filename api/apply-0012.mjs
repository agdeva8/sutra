import { config as loadEnv } from 'dotenv'
loadEnv({ path: '.env' })
import { readFileSync } from 'node:fs'
import { Client } from 'pg'

const sql = readFileSync('./db/migrations/0012_plan_items.sql', 'utf8')
const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL
if (!url) { throw new Error('No DATABASE_URL') }
console.log('Connecting…')
const client = new Client({ connectionString: url })
await client.connect()
console.log('Connected.')
try {
  await client.query(sql)
  console.log('OK — 0012 applied')
  const r = await client.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = 'plan_items'",
  )
  console.log('plan_items table present:', r.rows.length === 1)
  const cols = await client.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='plan_items' ORDER BY ordinal_position",
  )
  console.log('columns:', cols.rows.map((x) => x.column_name).join(', '))
} finally {
  await client.end()
}