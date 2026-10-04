#!/usr/bin/env tsx
/**
 * Verify the *replan engine* for a single user, straight from the DB.
 *
 * The engine is the pair:
 *   - `computeReplanSuggestions`  → the deterministic trigger (api/lib/replan-suggestions.ts)
 *   - `review_progress` planner   → the new orchestrator + prompts that answer it
 *                                    (api/lib/goal-planner/orchestrator.ts, uncommitted)
 *
 * A persona "uses the wrong engine" if it has any state that the deterministic
 * triggers would fire on, yet no recent `review_progress` proposal/audit exists
 * for that goal — i.e. it was seeded before the replan-engine change and was
 * never re-planned on the new engine.
 *
 * Read-only. Reports per goal so you can eyeball the demo personas.
 *
 * Usage:
 *   pnpm tsx scripts/verify-replan-engine.ts                # all personas
 *   pnpm tsx scripts/verify-replan-engine.ts <email-or-id>  # one user
 */

import 'dotenv/config'

import pg from 'pg'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  console.error('[verify-replan] DATABASE_URL is not set. Aborting.')
  process.exit(2)
}
if (process.env.ALLOW_DEV_LOGIN !== 'true') {
  console.error('[verify-replan] ALLOW_DEV_LOGIN must be "true". Aborting.')
  process.exit(2)
}

const { Pool } = pg
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } }) as pg.Pool & {
  query: <T = any>(text: string, values?: unknown[]) => Promise<{ rows: T[] }>
}

/* The five triggers, mirrored from api/lib/replan-suggestions.ts. Kept here
 * as a check-list so a new trigger added there shows up as a gap. */
const TRIGGERS = [
  'drift',
  'infeasible_edit',
  'timetable_collision',
  'blocker_collision',
  'capacity_freed',
] as const

interface Goal {
  id: string
  title: string
  status: string
  drift_status: string | null
  milestone_gap: boolean
  overdue_commits: number
}

function isoToday(): string {
  return new Date().toISOString().slice(0, 10)
}
function isoMinusDays(iso: string, days: number): string {
  const dt = new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)))
  dt.setUTCDate(dt.getUTCDate() - days)
  return dt.toISOString().slice(0, 10)
}

async function findUsers(selector?: string) {
  if (!selector) {
    return (
      await query<{ id: string; name: string | null; email: string | null; persona_key: string | null }>(
        `select id, name, email, persona_key from users
         where persona_key is not null or is_guest = true
         order by persona_weight asc, created_at desc`,
      )
    ).rows
  }
  return (
    await query<{ id: string; name: string | null; email: string | null; persona_key: string | null }>(
      `select id, name, email, persona_key from users
       where id = $1 or email = $1 or name = $1
       order by created_at desc limit 5`,
      [selector],
    )
  ).rows
}

function query<T = any>(text: string, values?: unknown[]) {
  return pool.query<T>(text, values)
}

async function inspect(userId: string): Promise<{ goals: Goal[]; fired: string[]; replanned: Set<string> }> {
  const today = isoToday()
  const weekAgo = isoMinusDays(today, 7)

  // Active goals + per-goal drift inputs (mirrors lib/goal-planner/drift.ts).
  const goalRows = (
    await query<{ id: string; title: string; status: string; drift_status: string | null; target_date: string | null }>(
      `select id, title, status, drift_status, target_date::text from goals
       where user_id = $1 and status = 'active'`,
      [userId],
    )
  ).rows

  const msRows = (
    await query<{ goal_id: string; title: string; target_date: string | null; status: string }>(
      `select goal_id, title, target_date::text, status from milestones where user_id = $1`,
      [userId],
    )
  ).rows
  const cRows = (
    await query<{ goal_id: string | null; due: string | null; status: string }>(
      `select goal_id, due::text, status from commitments where user_id = $1`,
      [userId],
    )
  ).rows

  const goals: Goal[] = goalRows.map((g) => {
    const ms = msRows.filter((m) => m.goal_id === g.id)
    const cs = cRows.filter((c) => c.goal_id === g.id)
    const milestoneGap = ms.some(
      (m) => !!m.target_date && m.target_date < today && m.status !== 'done',
    )
    const overdueCommits = cs.filter(
      (c) => c.status === 'open' && !!c.due && c.due < today && c.due >= weekAgo,
    ).length
    return {
      id: g.id,
      title: g.title,
      status: g.status,
      drift_status: g.drift_status,
      milestone_gap: milestoneGap,
      overdue_commits: overdueCommits,
    }
  })

  // Every trigger that has *any* state which could fire for this user.
  const fired = new Set<string>()
  if (goals.some((g) => g.milestone_gap || g.overdue_commits >= 3)) fired.add('drift')
  if (goals.some((g) => g.drift_status === 'at_risk')) fired.add('drift')

  const blockers = (
    await query<{ id: string; title: string; start_date: string | null; end_date: string | null }>(
      `select id, title, start_date::text, end_date::text from blockers where user_id = $1`,
      [userId],
    )
  ).rows
  for (const b of blockers) {
    if (!b.start_date) continue
    const bEnd = b.end_date || b.start_date
    const collides = goalRows.some((g) => {
      if (!g.target_date) return false
      return b.start_date! <= g.target_date && bEnd >= today
    })
    if (collides) fired.add('blocker_collision')
  }

  const tb = (
    await query<{ goal_id: string | null; block_date: string | null }>(
      `select goal_id, block_date::text from timetable_blocks where user_id = $1 and goal_id is not null`,
      [userId],
    )
  ).rows
  for (const block of tb) {
    const goal = goalRows.find((g) => g.id === block.goal_id)
    if (!goal || !block.block_date) continue
    if (goal.target_date && block.block_date > goal.target_date) fired.add('timetable_collision')
    const onBlocker = blockers.some((b) => {
      if (!b.start_date) return false
      const end = b.end_date || b.start_date
      return b.start_date <= block.block_date! && block.block_date! <= end
    })
    if (onBlocker) fired.add('timetable_collision')
  }

  const edits = (
    await query<{ type: string; payload: unknown; created_at: string }>(
      `select type, payload, created_at::text from audit_log
       where user_id = $1
         and type in ('confirm:update_goal','confirm:set_goal_dates','update:goal')
       order by created_at desc limit 20`,
      [userId],
    )
  ).rows
  const dropped = (
    await query<{ type: string; payload: unknown; created_at: string }>(
      `select type, payload, created_at::text from audit_log
       where user_id = $1
         and type in ('drop:goal','confirm:drop_goal','confirm:pause_goal','confirm:update_goal','update:goal')
       order by created_at desc limit 20`,
      [userId],
    )
  ).rows
  for (const a of [...edits, ...dropped]) {
    const p = (a.payload && typeof a.payload === 'object' ? a.payload : {}) as Record<string, unknown>
    const freed = typeof p.freed_weekly_hours === 'number' ? p.freed_weekly_hours : 0
    if (freed > 0) fired.add('capacity_freed')
    if (p.goal_id || (p.args && typeof p.args === 'object')) {
      if (a.type !== 'confirm:pause_goal') fired.add('infeasible_edit')
    }
  }

  // Did a review_progress proposal / confirm ever land for this user?
  const rp = (
    await query<{ n: string }>(
      `select count(*)::text as n from audit_log
       where user_id = $1 and (type like '%review_progress%' or summary ilike '%review_progress%')`,
      [userId],
    )
  ).rows[0]?.n
  const replanned = new Set<string>()
  if (Number(rp) > 0) goals.forEach((g) => replanned.add(g.id))

  return { goals, fired: [...fired], replanned }
}

async function main() {
  const selector = process.argv[2]
  const users = await findUsers(selector)
  if (users.length === 0) {
    console.log(`[verify-replan] no users matched ${selector ?? '(personas)'}`)
    await pool.end()
    return
  }

  console.log(`[verify-replan] ${users.length} user(s). Triggers checked: ${TRIGGERS.join(', ')}\n`)
  let needEngine = 0
  for (const u of users) {
    const { goals, fired, replanned } = await inspect(u.id)
    const hasFiredState = fired.length > 0
    const wrong = hasFiredState && replanned.size === 0
    if (wrong) needEngine += 1
    console.log(
      `${wrong ? '✗' : '✓'} ${u.persona_key ?? u.id}  ${u.name ?? ''} <${u.email ?? ''}>`,
    )
    console.log(
      `   goals(active)=${goals.length} fired=[${fired.join(',') || 'none'}] review_progress=${replanned.size > 0 ? 'yes' : 'no'}`,
    )
    for (const g of goals.slice(0, 8)) {
      console.log(
        `     · ${g.title} [drift=${g.drift_status ?? 'null'} milestone_gap=${g.milestone_gap} overdue=${g.overdue_commits}]`,
      )
    }
  }
  console.log(
    `\n[verify-replan] ${needEngine} user(s) have replan-triggering state but no review_progress run — re-seed these on the new engine.`,
  )
  await pool.end()
}

main().catch(async (e) => {
  console.error('[verify-replan] failed:', e)
  await pool.end().catch(() => {})
  process.exit(1)
})
