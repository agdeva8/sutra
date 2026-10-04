/**
 * Sutra Drizzle schema — Phase 1.
 *
 * Source of truth: migration/discovery/03-nextjs-architecture.md Section 2.
 *
 * 9 domain tables (mirror the 9 Mongo collections in
 * migration/discovery/01-mongo-schema.md) + 3 Auth.js tables (accounts,
 * sessions, verificationTokens) required by @auth/drizzle-adapter.
 *
 * Design notes:
 *  - All primary keys are TEXT — preserved Mongo string IDs (e.g. user_xxx,
 *    goal_xxx) so the ETL in db/migrate-from-mongo.ts can stream rows 1:1.
 *  - Timestamps use Postgres `timestamp with time zone` (`timestamptz`) so
 *    `defaultNow()` returns a UTC instant in Postgres and reads back as a
 *    JS Date in Drizzle without timezone surprises.
 *  - Date-only columns (e.g. start_date, target_date) use Postgres `date`
 *    so Mongo's ISO date strings round-trip cleanly.
 *  - proposals.args and audit_log.payload are JSONB per the architecture
 *    plan so we can index/query nested fields later without migration
 *    churn.
 *  - FK actions: ON DELETE CASCADE for owned children of a user
 *    (commitments, milestones, blockers, messages, audit_log, sources);
 *    ON DELETE SET NULL for goal_id references where the parent goal may
 *    be removed but the child row (e.g. a milestone) is still useful.
 *  - No explicit secondary indexes are declared here. The architecture
 *    sketch is the source of truth; if/when we add
 *    (user_id, created_at DESC) etc. they go in a later migration so the
 *    generated 0001_init.sql matches the plan byte-for-byte.
 */

import { desc, sql } from 'drizzle-orm'
import {
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  time,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

/* -------------------------------------------------------------------------- */
/* Domain tables                                                              */
/* -------------------------------------------------------------------------- */

export const users = pgTable('users', {
  id: text('id').primaryKey(), // 'user_xxx' (preserve IDs)
  email: text('email').unique(),
  name: text('name'),
  // `image` matches @auth/drizzle-adapter's expected column name (the
  // adapter writes the Google profile picture URL here). Renamed from
  // `picture` per Auth.js v5 convention. ETL in migrate-from-mongo.ts
  // reads `doc.picture` from Mongo and writes it into `image`.
  image: text('image'),
  // `emailVerified` is written by the Auth.js adapter when Google returns
  // a verified email. Optional — guests and unverified users have null.
  emailVerified: timestamp('email_verified', { withTimezone: true, mode: 'date' }),
  modelProvider: text('model_provider').notNull().default('gemini'),
  isGuest: boolean('is_guest').notNull().default(false),
  // Phase 2 — curated dev personas. `personaKey` is a stable display
  // handle (`founder`, `starter`, `overdue`, `dormant`, `dense`,
  // `memory_heavy`); it does NOT replace `users.id` (the row id remains
  // the auth identity). `personaWeight` orders the persona menu so the
  // founder is always first.
  personaKey: text('persona_key'),
  personaWeight: integer('persona_weight').notNull().default(0),
  // Iteration 10 (Goal Planner) — weekly hours the user is willing to give
  // to tracked goals across ALL life areas (a discretionary time budget, not
  // office hours). NULL = not set; Stage 3.5 then treats headroom as advisory
  // (names the tension in prose, does not auto-renegotiate) until the user
  // sets it in Settings. See memory/PRD.md Iteration 10.
  availableWeeklyHours: integer('available_weekly_hours'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (t) => [
  // Declared here (rather than in a hand-written migration) so the schema is
  // the source of truth — without this, drizzle-kit generate proposes
  // dropping this live index on every run. Mirrors 0006_personas.sql.
  uniqueIndex('users_persona_key_unique')
    .on(t.personaKey)
    .where(sql`"users"."persona_key" is not null`),
])

export const goals = pgTable('goals', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  horizon: text('horizon', {
    enum: ['weekly', 'short', 'medium', 'long'],
  }).notNull(),
  why: text('why').notNull().default(''),
  nextAction: text('next_action').notNull().default(''),
  startDate: date('start_date'),
  targetDate: date('target_date'),
  // Iteration 10 (Goal Planner) — the three plan fields.
  //   weeklyHours: NULL = not yet estimated. Excluded from the Stage 3.5
  //     load sum until the LLM estimates it during a (re)plan, so existing
  //     goals never read as phantom over-commitment.
  //   phaseObjectives: JSONB map { "<phase name>": "<verifiable objective>" },
  //     2-4 entries, keys referenced by milestones.phase / commitments.phase.
  //   driftStatus: plan-vs-actual drift flag (see Iteration 10 §Drift).
  //   lifeArea: one of the six UI areas (Health | Career | Learning |
  //     Relationship | Finance | Side project) or '' when unsorted. Display +
  //     balance reasoning only — capacity stays a single global pool.
  weeklyHours: integer('weekly_hours'),
  phaseObjectives: jsonb('phase_objectives').notNull().default({}),
  driftStatus: text('drift_status', { enum: ['on_track', 'at_risk'] })
    .notNull()
    .default('on_track'),
  lifeArea: text('life_area').notNull().default(''),
  status: text('status', {
    enum: ['active', 'paused', 'dropped'],
  })
    .notNull()
    .default('active'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export const commitments = pgTable('commitments', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  goalId: text('goal_id').references(() => goals.id, { onDelete: 'set null' }),
  goalTitle: text('goal_title').notNull().default(''),
  text: text('text').notNull(),
  // Iteration 5 (Bug 7) — free-text "what you did" note from the Today
  // timetable. Persists on the row alongside `text` and is rendered back
  // in the tile. Added by migration 0007_commitments_note.sql to live DB
  // (0001_init does not create the column). Nullable on purpose so the
  // optimistic-save path on TodayTimetable leaves no half-written state.
  note: text('note').default(''),
  due: date('due'),
  // Iteration 10 (Goal Planner) — phase name; key in goal.phase_objectives.
  phase: text('phase').notNull().default(''),
  status: text('status', { enum: ['open', 'done'] })
    .notNull()
    .default('open'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export const milestones = pgTable('milestones', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  goalId: text('goal_id').references(() => goals.id, { onDelete: 'set null' }),
  goalTitle: text('goal_title').notNull().default(''),
  title: text('title').notNull(),
  targetDate: date('target_date'),
  // Iteration 10 (Goal Planner) — phase name; key in goal.phase_objectives.
  phase: text('phase').notNull().default(''),
  status: text('status').notNull().default('open'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

/**
 * Iteration 10.2 (multi-horizon execution) — the canonical persisted plan.
 *
 * One row per horizon item across all five levels:
 *   yearly    -> the goal span itself
 *   quarterly -> phase spans (2-4, computed by the scheduler)
 *   monthly   -> milestones (each dated by the scheduler)
 *   weekly    -> derived checkpoints inside each phase's effective window
 *   daily     -> commitments (the smallest next actions)
 *
 * The scheduler (`lib/goal-planner/scheduler.ts`) computes these rows with a
 * 20% per-horizon timeline buffer; the proposal executor writes them on
 * confirm, keyed to the goal. Rows carry `status` so the execution dashboard
 * and per-horizon drift can read open/done state. CASCADE (not SET NULL like
 * milestones) because a plan is meaningless without its goal.
 */
export const planItems = pgTable('plan_items', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  goalId: text('goal_id').references(() => goals.id, { onDelete: 'cascade' }),
  horizon: text('horizon', {
    enum: ['daily', 'weekly', 'monthly', 'quarterly', 'yearly'],
  }).notNull(),
  phase: text('phase').notNull().default(''),
  title: text('title').notNull(),
  note: text('note').notNull().default(''),
  startDate: date('start_date'),
  endDate: date('end_date'),
  dueDate: date('due_date'),
  weeklyHours: integer('weekly_hours'),
  status: text('status', { enum: ['open', 'done'] })
    .notNull()
    .default('open'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (t) => [
  index('plan_items_user_horizon_idx').on(t.userId, t.horizon, t.startDate),
  index('plan_items_goal_idx').on(t.goalId),
])

export const blockers = pgTable('blockers', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  startDate: date('start_date').notNull(),
  endDate: date('end_date'),
  note: text('note').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

/* -------------------------------------------------------------------------- */
/* Conversations — Phase 3 thread model                                        */
/*                                                                             */
/* A conversation is one coach thread: a fresh thread is opened when the user */
/* hits "Add goal", "Plan my day", or "Review progress" from the dashboard, so */
/* each starts from a clean transcript. The migration seeds one `general`     */
/* conversation per existing user (id `conv_general_<user_id>`); newly-created */
/* guests get their `general` row on first chat insert (idempotent INSERT).   */
/* -------------------------------------------------------------------------- */

export const conversations = pgTable('conversations', {
  id: text('id').primaryKey(), // 'conv_general_<user_id>' or 'conv_<kind>_<uuid>'
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind', {
    enum: ['general', 'add_goal', 'plan_day', 'review_progress', 'edit_goal', 'drop_goal'],
  })
    .notNull()
    .default('general'),
  goalId: text('goal_id').references(() => goals.id, { onDelete: 'set null' }),
  title: text('title').notNull().default(''),
  status: text('status', { enum: ['open', 'closed'] })
    .notNull()
    .default('open'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  lastMessageAt: timestamp('last_message_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  // Iteration N — sealed on first confirm; chat route refuses to append
  // to closed buckets (defensive redirect). See migration 0009.
  closedAt: timestamp('closed_at', { withTimezone: true }),
}, (t) => [
  // Mirror 0006_conversations.sql so generate doesn't drop them.
  index('conversations_user_open_idx')
    .on(t.userId)
    .where(sql`status = 'open'`),
  index('conversations_user_recent_idx').on(t.userId, desc(t.lastMessageAt)),
])

export const messages = pgTable('messages', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  // Phase 3 — every chat thread belongs to a conversation row. The
  // default per-user thread is `conv_general_<user_id>`, seeded by
  // migration 0006_conversations.sql. The schema enforces NOT NULL so
  // dangling messages are impossible. Pass an explicit conversationId
  // from the chat route; clients that need a fresh thread mint a
  // new conversation row first.
  conversationId: text('conversation_id')
    .notNull()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  role: text('role', { enum: ['user', 'assistant'] }).notNull(),
  content: text('content').notNull(),
  provider: text('provider'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (t) => [
  // Mirror 0006_conversations.sql.
  index('messages_conversation_created_idx').on(t.conversationId, t.createdAt),
])

export const proposals = pgTable('proposals', {
  id: text('id').primaryKey(),
  messageId: text('message_id')
    .notNull()
    .references(() => messages.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  // Phase 3 — see messages.conversationId above.
  conversationId: text('conversation_id')
    .notNull()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  action: text('action').notNull(),
  args: jsonb('args').notNull(),
  status: text('status', { enum: ['pending', 'confirmed', 'rejected'] })
    .notNull()
    .default('pending'),
  result: text('result'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
}, (t) => [
  // Mirror 0006_conversations.sql.
  index('proposals_conversation_created_idx').on(t.conversationId, t.createdAt),
])

export const auditLog = pgTable('audit_log', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  summary: text('summary').notNull(),
  payload: jsonb('payload').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export const sources = pgTable('sources', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  goalId: text('goal_id').references(() => goals.id, { onDelete: 'set null' }),
  goalTitle: text('goal_title').notNull().default(''),
  kind: text('kind', { enum: ['file', 'link'] }).notNull(),
  storagePath: text('storage_path').notNull().default(''),
  originalFilename: text('original_filename').notNull(),
  contentType: text('content_type').notNull(),
  size: integer('size').notNull().default(0),
  url: text('url').notNull().default(''),
  textExcerpt: text('text_excerpt'),
  isDeleted: boolean('is_deleted').notNull().default(false),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (t) => [index('sources_expires_at_idx').on(t.expiresAt)])

/* -------------------------------------------------------------------------- */
/* Memories — user-pinned photos and Instagram-style embeds. Distinct from   */
/* `sources` (which are reference material the coach reasons over) — these  */
/* are the user's own 'why does this matter' artefacts that anchor goals.    */
/*                                                                             */
/* Photo kind:        source_id pointer to the underlying `sources` row.     */
/* Instagram kind:    external_url + parsed shortcode. The embed displays   */
/*                    via the canonical instagram.com/p/{shortcode}/embed   */
/*                    URL; we don't scrape Instagram (no auth, fragile).     */
/* ------------------------------------------------------------------------- */
export const memories = pgTable('memories', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['photo', 'instagram'] }).notNull(),
  caption: text('caption').notNull().default(''),
  goalId: text('goal_id').references(() => goals.id, { onDelete: 'set null' }),
  goalTitle: text('goal_title').notNull().default(''),
  sourceId: text('source_id'),
  externalUrl: text('external_url'),
  instagramShortcode: text('instagram_shortcode'),
  width: integer('width'),
  height: integer('height'),
  mimeType: text('mime_type'),
  sizeBytes: integer('size_bytes'),
  // Phase 7 — memories attach to a calendar cell rather than a goal.
  // `occurred_on` is the primary anchor; start/end_time are optional for
  // an in-day placement. Migration 0006_memories_dates.sql made
  // occurred_on NOT NULL after backfilling legacy rows.
  occurredOn: date('occurred_on').notNull(),
  startTime: time('start_time'),
  endTime: time('end_time'),
  metadata: jsonb('metadata').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (t) => [
  // Mirror 0006_memories_dates.sql.
  index('memories_user_date_idx').on(t.userId, t.occurredOn),
])

/* -------------------------------------------------------------------------- */
/* Timetable blocks — Phase 6 planner                                          */
/*                                                                             */
/* Manual UI CRUD remains available. `plan_day` can also create blocks through */
/* the coach's proposal -> user-confirm path. `source=plan` marks those blocks;*/
/* `manual` means the user typed the block directly. A block can be a          */
/* commitment, routine, blocker, or focus slot.                               */
/* -------------------------------------------------------------------------- */

export const timetableBlocks = pgTable('timetable_blocks', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  blockDate: date('block_date').notNull(),
  startTime: time('start_time').notNull(),
  endTime: time('end_time').notNull(),
  label: text('label').notNull(),
  kind: text('kind', { enum: ['commitment', 'routine', 'blocker', 'focus'] })
    .notNull()
    .default('commitment'),
  source: text('source', { enum: ['manual', 'plan', 'commitment', 'blocker'] })
    .notNull()
    .default('manual'),
  sourceId: text('source_id'),
  goalId: text('goal_id').references(() => goals.id, { onDelete: 'set null' }),
  goalTitle: text('goal_title').notNull().default(''),
  note: text('note').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (t) => [
  // Mirror 0006_timetable_blocks.sql.
  index('timetable_blocks_user_date_idx').on(t.userId, t.blockDate, t.startTime),
])

/* -------------------------------------------------------------------------- */
/* Auth.js v5 tables (per @auth/drizzle-adapter spec)                         */
/*                                                                             */
/* Even though we use JWT session strategy (see architecture plan Section 3),  */
/* the adapter still expects all four tables to exist so it can write rows     */
/* for OAuth account linking.                                                 */
/* -------------------------------------------------------------------------- */

export const accounts = pgTable(
  'accounts',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    provider: text('provider').notNull(),
    providerAccountId: text('provider_account_id').notNull(),
    refresh_token: text('refresh_token'),
    access_token: text('access_token'),
    expires_at: integer('expires_at'),
    token_type: text('token_type'),
    scope: text('scope'),
    id_token: text('id_token'),
    session_state: text('session_state'),
  },
  (account) => [
    primaryKey({
      columns: [account.provider, account.providerAccountId],
    }),
  ]
)

export const sessions = pgTable('sessions', {
  sessionToken: text('session_token').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expires: timestamp('expires', { withTimezone: true }).notNull(),
})

export const verificationTokens = pgTable(
  'verification_tokens',
  {
    identifier: text('identifier').notNull(),
    token: text('token').notNull(),
    expires: timestamp('expires', { withTimezone: true }).notNull(),
  },
  (vt) => [
    primaryKey({
      columns: [vt.identifier, vt.token],
    }),
  ]
)

/* -------------------------------------------------------------------------- */
/* user_sessions — runtime-managed session tokens                             */
/*                                                                             */
/* Mirror of the legacy Python `user_sessions` collection. Links Emergent-    */
/* issued `session_token` cookies to a `users.id`. Read/written by raw SQL   */
/* in lib/auth.ts (see auth.ts:161 SELECT, auth.ts:229 INSERT).               */
/* -------------------------------------------------------------------------- */

export const userSessions = pgTable('user_sessions', {
  sessionToken: text('session_token').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/* -------------------------------------------------------------------------- */
/* state_overrides — per-user tunable overrides to computed state              */
/*                                                                             */
/* Referenced from lib/auth.ts:255 in the guest-migration UPDATE loop.       */
/* Shape (jsonb `payload`) is forward-compatible — the migration only needs   */
/* `user_id` to exist for the UPDATE SET user_id = ... WHERE user_id = ...   */
/* to succeed; no read/write paths exist yet.                                  */
/* -------------------------------------------------------------------------- */

export const stateOverrides = pgTable('state_overrides', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  payload: jsonb('payload'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

/* -------------------------------------------------------------------------- */
/* Motivation pipeline tables (Iteration 6, Motivation Pipeline v1)            */
/*                                                                             */
/* Mirror the migration at db/migrations/0008_motivation_pipeline.sql. The     */
/* orchestrator at api/lib/motivation/recommend.ts reads motivation_cache for  */
/* fast repeats and writes motivation_rejects per non-passing candidate so we  */
/* can tune the 10-dim weights and prompt over time. motivation_served_log     */
/* enforces DAILY_USER_CAP (config.ts) by counting cache-miss calls per day.   */
/* -------------------------------------------------------------------------- */

export const motivationCache = pgTable(
  'motivation_cache',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    bucket: text('bucket', {
      enum: ['overdue', 'dormant', 'stuck'],
    }).notNull(),
    /** Hash of (overdue ids + goal updated_at + chat theme bag). */
    stateHash: text('state_hash').notNull(),
    /** JSON array of RecommendationItem. Matches RecommendationResponseSchema.items. */
    items: jsonb('items').notNull(),
    generatedAt: timestamp('generated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** 60m TTL from generatedAt. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.bucket, t.stateHash] }),
  ],
)

export const motivationRejects = pgTable('motivation_rejects', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  bucket: text('bucket', {
    enum: ['overdue', 'dormant', 'stuck'],
  }).notNull(),
  url: text('url').notNull(),
  title: text('title').notNull().default(''),
  scoreBreakdown: jsonb('score_breakdown').notNull(),
  weightedTotal: doublePrecision('weighted_total').notNull(),
  topReasons: jsonb('top_reasons').notNull().default([]),
  /** Array of gate names that failed: 'core_four' | 'k_of_n' | 'weighted_total'. */
  gatesFailed: jsonb('gates_failed').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export const motivationServedLog = pgTable(
  'motivation_served_log',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    servedOn: date('served_on').notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.servedOn] }),
  ],
)

/* -------------------------------------------------------------------------- */
/* Goal Planner tables (Iteration 10)                                         */
/*                                                                             */
/* See memory/PRD.md Iteration 10. Both tables are independent of the rest of */
/* the schema (no migration of existing data).                                 */
/* -------------------------------------------------------------------------- */

/**
 * One row per (user, day) — the coach's memory of the day across sessions.
 *
 * Upserted by `PUT /api/daily_log` (effect 5.3). Carries the section-level
 * free text from the Today tab plus JSON snapshots of that day's commitment
 * tick states / notes and blocker skips. Without it every chat starts blank
 * because the transcript is scoped per-conversation.
 *
 * Composite PK (userId, logDate) rather than a synthetic id: the upsert is
 * the identifier. The PRD's illustrative `id` column is omitted on purpose.
 */
export const dailyLog = pgTable(
  'daily_log',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    logDate: date('log_date').notNull(),
    text: text('text').notNull().default(''),
    /** [{ commitment_id, completed, note }] */
    commitments: jsonb('commitments').notNull().default([]),
    /** [{ blocker_id, skipped, note }] */
    blockers: jsonb('blockers').notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.logDate] })],
)

/**
 * Observability mirror of `motivation_rejects` — one row per candidate a
 * pipeline stage produced that failed a gate or the cross-validator. Used to
 * tune the per-stage prompts and to compute the rollout gate (roll back if
 * rejection rate > 10% over 48h). `recovered` records whether a retry or the
 * legacy fallback ultimately salvaged a usable plan.
 */
export const planRejects = pgTable('plan_rejects', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** Conversation intent: add_goal | plan_day | edit_goal | drop_goal | review_progress. */
  intent: text('intent').notNull(),
  stage: text('stage', {
    enum: ['intake', 'plan', 'emit', 'cross_validate'],
  }).notNull(),
  reason: text('reason').notNull().default(''),
  rawInput: jsonb('raw_input').notNull().default({}),
  rawOutput: jsonb('raw_output').notNull().default({}),
  recovered: boolean('recovered').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})
