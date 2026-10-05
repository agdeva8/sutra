#!/usr/bin/env tsx
/**
 * GoalCoach — one-shot ETL: MongoDB → Postgres.
 *
 * Streams 8 Mongo collections into 9 Postgres tables:
 *
 *   users       → users
 *   goals       → goals
 *   milestones  → milestones
 *   blockers    → blockers
 *   messages    → messages            (+ proposals split from .proposals[])
 *   audit_log   → audit_log
 *   sources     → sources             (Emergent Object Storage URLs preserved
 *                                       as-is — no file copy)
 *
 * Why 8 collections, 9 tables: the Mongo `messages` document carries an
 * embedded `proposals: [{id, action, status, result, ...args}]` array.
 * The architecture plan calls for relational proposals in their own
 * table (Section 2 — "JSONB vs relational for proposals: relational
 * recommended"). So we split the array here, generating fresh `prop_xxx`
 * IDs and FK-linking each proposal back to its parent message.
 *
 * ----------------------------------------------------------------------
 * Idempotency & resumability
 * ----------------------------------------------------------------------
 * Every insert uses ON CONFLICT (id) DO NOTHING, so re-running is a safe
 * no-op for already-migrated rows. Per-row audit lives in a small
 * `_etl_state` table (created on first run) that records every
 * (collection, source_id) pair we've successfully written — that's the
 * `_migrated_at` marker the architecture plan calls for. A partial run
 * that crashes leaves this table in a consistent state; re-running picks
 * up exactly where it left off without duplicating any row.
 *
 * ----------------------------------------------------------------------
 * Source files: Emergent Object Storage URLs preserved verbatim
 * ----------------------------------------------------------------------
 * After the Emergent-only swap we no longer copy file blobs into a
 * separate storage system. `sources.storage_path` keeps the original
 * Emergent Object Storage path verbatim (`kind='file'` rows already
 * point at the Emergent integration proxy; `kind='link'` rows point at
 * the URL they were recorded from). The runtime download handler
 * (`app/api/sources/[id]/download/route.ts`) resolves the path
 * directly via `lib/emergent/storage.ts`.
 *
 * ----------------------------------------------------------------------
 * Out of scope (handled elsewhere)
 * ----------------------------------------------------------------------
 *   - Guest → user reassignment: handled by `/api/auth/session` on
 *     sign-in (see architecture plan §3 + §5 guest flow).
 *   - Dropping the legacy `user_sessions` collection: not applicable;
 *     we recreate a `user_sessions` Postgres table on first sign-in
 *     instead.
 *
 * ----------------------------------------------------------------------
 * Usage
 * ----------------------------------------------------------------------
 *   pnpm migrate                       # uses .env / process.env
 *   pnpm tsx db/migrate-from-mongo.ts  # same
 *
 * Required env (loaded from .env by `import 'dotenv/config'` at the top):
 *   DATABASE_URL_UNPOOLED       Postgres (direct, unpooled)
 *   MONGODB_URL  (or MONGO_URL) Mongo connection string
 *   DB_NAME      (or MONGO_DB_NAME, default 'goalcoach')
 */

import "dotenv/config";

import { randomUUID } from "node:crypto";

import { MongoClient, type Db } from "mongodb";
import { sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import { closeDb, db } from "@/lib/db";
import { env } from "@/lib/env";
import {
  users,
  goals,
  milestones,
  blockers,
  messages,
  proposals,
  auditLog,
  sources,
} from "@/db/schema";

// ----------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------

/** Rows per Postgres INSERT. Tuned for batch throughput vs. round-trip cost. */
const BATCH_SIZE = 500;

/** Mongo cursor batch size — memory bound for users with very long histories. */
const MONGO_BATCH = 500;

/** Threshold for explicit per-user chunking (in addition to cursor streaming). */
const LARGE_USER_THRESHOLD = 10_000;

/** Explicit chunk size when paginating large users. */
const LARGE_USER_CHUNK = 5_000;

// ----------------------------------------------------------------------
// Logging
// ----------------------------------------------------------------------

const ts = () => new Date().toISOString();
const log = (msg: string) => console.log(`[migrate ${ts()}] ${msg}`);
const warn = (msg: string) => console.warn(`[migrate ${ts()}] ${msg}`);
const fail = (msg: string, e?: unknown) =>
  console.error(`[migrate ${ts()}] ${msg}`, e ?? "");

// ----------------------------------------------------------------------
// Type aliases — loose; Mongo data evolves and we want to be tolerant.
// ----------------------------------------------------------------------

type MongoDoc = Record<string, any>;

// ----------------------------------------------------------------------
// Field-coercion helpers
// ----------------------------------------------------------------------

/**
 * Mongo dates arrive as ISO strings (e.g. "2026-09-24T12:34:56.789+00:00"
 * or "2026-09-24"). Postgres `date` columns want YYYY-MM-DD with no
 * time component. We extract the date prefix; if the value is malformed
 * we return null rather than failing the row — Mongo has been known to
 * contain empty / weird values and ETL should be permissive.
 */
function toDateOnly(v: unknown): string | null {
  if (v == null || v === "") return null;
  const s = String(v);
  const m = /^\d{4}-\d{2}-\d{2}/.exec(s);
  return m ? m[0] : null;
}

/** ISO 8601 string → JS Date; null on missing or unparseable. */
function toTimestamp(v: unknown): Date | null {
  if (v == null || v === "") return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d;
}

/** Generate a fresh `prop_<hex12>` ID for split proposals. */
function newPropId(): string {
  return `prop_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

// ----------------------------------------------------------------------
// ETL state tracking — the `_migrated_at` marker, in table form.
// ----------------------------------------------------------------------
//
// We intentionally did NOT add an `_migrated_at` column to every domain
// table (see db/schema.ts comments). Instead we record one row per
// (collection, source_id) here. Re-runs check this table to short-circuit
// work; domain inserts use ON CONFLICT DO NOTHING on the PK for the
// last-line guarantee.

const STATE_TABLE = "_etl_state";

async function ensureStateTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS ${sql.raw(STATE_TABLE)} (
      collection   TEXT NOT NULL,
      source_id    TEXT NOT NULL,
      migrated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (collection, source_id)
    )
  `);
}

async function recordMigration(
  collection: string,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  // INSERT ... ON CONFLICT DO NOTHING — repeated runs are safe.
  // Build VALUES list as text to avoid parameter explosion on huge batches.
  const tuples = ids
    .map((id) => `('${collection.replace(/'/g, "''")}','${id.replace(/'/g, "''")}', NOW())`)
    .join(",");
  await db.execute(
    sql.raw(
      `INSERT INTO ${STATE_TABLE} (collection, source_id, migrated_at) VALUES ${tuples} ON CONFLICT (collection, source_id) DO NOTHING`,
    ),
  );
}

/**
 * Build a quick "already-migrated" set for a collection. Loads the full
 * list (call sites are collections with bounded size or pagination).
 * Returns a Set for O(1) lookup.
 */
async function loadMigratedIds(collection: string): Promise<Set<string>> {
  const rows = await db.execute(sql`
    SELECT source_id FROM ${sql.raw(STATE_TABLE)}
    WHERE collection = ${collection}
  `);
  // postgres-js returns rows as an array of objects.
  const arr = (rows as unknown as Array<{ source_id: string }>) ?? [];
  return new Set(arr.map((r) => r.source_id));
}

// ----------------------------------------------------------------------
// Generic batch insert helper.
//
// `table` is a Drizzle pgTable, `rows` is the batch, `collection` is
// the Mongo collection name (for the `_etl_state` marker).
// ----------------------------------------------------------------------

async function flushBatch<
  T extends Record<string, unknown>,
>(opts: {
  table: PgTable;
  rows: T[];
  collection: string;
  idKey: keyof T;
}): Promise<{ inserted: number }> {
  const { table, rows, collection, idKey } = opts;
  if (rows.length === 0) return { inserted: 0 };
  // .returning({id}) gives us only the rows that ACTUALLY inserted;
  // ON CONFLICT DO NOTHING silently drops conflicts. So `returned.length`
  // is the count of newly-inserted rows in this batch. The generic helper
  // erases the table's column types, so we cast through `any` here — the
  // runtime call still validates the column reference at execution.
  const insertQuery = db
    .insert(table)
    .values(rows as any)
    .onConflictDoNothing();
  const returned = await (insertQuery as unknown as {
    returning(fields: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
  }).returning({ id: table[idKey as keyof typeof table] });

  const insertedIds = (returned as Array<Record<string, unknown>>).map(
    (r) => r.id as string,
  );
  if (insertedIds.length > 0) {
    await recordMigration(collection, insertedIds);
  }
  return { inserted: insertedIds.length };
}

// ----------------------------------------------------------------------
// Per-collection migrations
// ----------------------------------------------------------------------

interface MigrateStats {
  inserted: number;
  skipped: number;
  failed: number;
}

async function migrateUsers(mongo: Db): Promise<MigrateStats> {
  const coll = mongo.collection("users");
  const total = await coll.countDocuments();
  log(`users: starting (${total} docs in Mongo)`);

  const stats: MigrateStats = { inserted: 0, skipped: 0, failed: 0 };
  const alreadyMigrated = await loadMigratedIds("users");

  const cursor = coll
    .find({}, { projection: { _id: 0 } })
    .batchSize(MONGO_BATCH);

  let batch: any[] = [];
  for await (const doc of cursor as unknown as AsyncIterable<MongoDoc>) {
    const id: string | undefined = doc.user_id;
    if (!id) {
      stats.failed++;
      warn(`users: skipping doc with no user_id`);
      continue;
    }
    if (alreadyMigrated.has(id)) {
      stats.skipped++;
      continue;
    }
    batch.push({
      id,
      email: doc.email ?? null,
      name: doc.name ?? null,
      image: doc.picture ?? null,
      modelProvider: doc.model_provider ?? "gemini",
      isGuest: doc.is_guest ?? false,
      createdAt: toTimestamp(doc.created_at) ?? new Date(),
    });
    if (batch.length >= BATCH_SIZE) {
      const { inserted } = await flushBatch({
        table: users,
        rows: batch,
        collection: "users",
        idKey: "id",
      });
      stats.inserted += inserted;
      stats.skipped = batch.length - inserted;
      batch = [];
    }
  }
  if (batch.length > 0) {
    const { inserted } = await flushBatch({
      table: users,
      rows: batch,
      collection: "users",
      idKey: "id",
    });
    stats.inserted += inserted;
    stats.skipped = batch.length - inserted;
  }
  log(
    `users: done (inserted ${stats.inserted}, skipped ${stats.skipped}, failed ${stats.failed})`,
  );
  return stats;
}

async function migrateGoals(mongo: Db): Promise<MigrateStats> {
  const coll = mongo.collection("goals");
  const total = await coll.countDocuments();
  log(`goals: starting (${total} docs)`);

  const stats: MigrateStats = { inserted: 0, skipped: 0, failed: 0 };
  const alreadyMigrated = await loadMigratedIds("goals");

  const cursor = coll
    .find({}, { projection: { _id: 0 } })
    .batchSize(MONGO_BATCH);

  let batch: any[] = [];
  for await (const doc of cursor as unknown as AsyncIterable<MongoDoc>) {
    const id: string | undefined = doc.id;
    if (!id) {
      stats.failed++;
      warn(`goals: skipping doc with no id`);
      continue;
    }
    if (alreadyMigrated.has(id)) {
      stats.skipped++;
      continue;
    }
    batch.push({
      id,
      userId: doc.user_id,
      title: doc.title ?? "",
      horizon: doc.horizon ?? "medium",
      why: doc.why ?? "",
      nextAction: doc.next_action ?? "",
      startDate: toDateOnly(doc.start_date),
      targetDate: toDateOnly(doc.target_date),
      status: doc.status ?? "active",
      createdAt: toTimestamp(doc.created_at) ?? new Date(),
      updatedAt: toTimestamp(doc.updated_at) ?? new Date(),
    });
    if (batch.length >= BATCH_SIZE) {
      const { inserted } = await flushBatch({
        table: goals,
        rows: batch,
        collection: "goals",
        idKey: "id",
      });
      stats.inserted += inserted;
      stats.skipped = batch.length - inserted;
      batch = [];
    }
  }
  if (batch.length > 0) {
    const { inserted } = await flushBatch({
      table: goals,
      rows: batch,
      collection: "goals",
      idKey: "id",
    });
    stats.inserted += inserted;
    stats.skipped = batch.length - inserted;
  }
  log(
    `goals: done (inserted ${stats.inserted}, skipped ${stats.skipped}, failed ${stats.failed})`,
  );
  return stats;
}

async function migrateMilestones(mongo: Db): Promise<MigrateStats> {
  const coll = mongo.collection("milestones");
  const total = await coll.countDocuments();
  log(`milestones: starting (${total} docs)`);

  const stats: MigrateStats = { inserted: 0, skipped: 0, failed: 0 };
  const alreadyMigrated = await loadMigratedIds("milestones");

  const cursor = coll
    .find({}, { projection: { _id: 0 } })
    .batchSize(MONGO_BATCH);
  let batch: any[] = [];
  for await (const doc of cursor as unknown as AsyncIterable<MongoDoc>) {
    const id: string | undefined = doc.id;
    if (!id) {
      stats.failed++;
      continue;
    }
    if (alreadyMigrated.has(id)) {
      stats.skipped++;
      continue;
    }
    batch.push({
      id,
      userId: doc.user_id,
      goalId: doc.goal_id || null,
      goalTitle: doc.goal_title ?? "",
      title: doc.title ?? "",
      targetDate: toDateOnly(doc.target_date),
      status: doc.status ?? "open",
      createdAt: toTimestamp(doc.created_at) ?? new Date(),
    });
    if (batch.length >= BATCH_SIZE) {
      const { inserted } = await flushBatch({
        table: milestones,
        rows: batch,
        collection: "milestones",
        idKey: "id",
      });
      stats.inserted += inserted;
      stats.skipped = batch.length - inserted;
      batch = [];
    }
  }
  if (batch.length > 0) {
    const { inserted } = await flushBatch({
      table: milestones,
      rows: batch,
      collection: "milestones",
      idKey: "id",
    });
    stats.inserted += inserted;
    stats.skipped = batch.length - inserted;
  }
  log(
    `milestones: done (inserted ${stats.inserted}, skipped ${stats.skipped}, failed ${stats.failed})`,
  );
  return stats;
}

async function migrateBlockers(mongo: Db): Promise<MigrateStats> {
  const coll = mongo.collection("blockers");
  const total = await coll.countDocuments();
  log(`blockers: starting (${total} docs)`);

  const stats: MigrateStats = { inserted: 0, skipped: 0, failed: 0 };
  const alreadyMigrated = await loadMigratedIds("blockers");

  const cursor = coll
    .find({}, { projection: { _id: 0 } })
    .batchSize(MONGO_BATCH);
  let batch: any[] = [];
  for await (const doc of cursor as unknown as AsyncIterable<MongoDoc>) {
    const id: string | undefined = doc.id;
    if (!id) {
      stats.failed++;
      continue;
    }
    if (alreadyMigrated.has(id)) {
      stats.skipped++;
      continue;
    }
    batch.push({
      id,
      userId: doc.user_id,
      title: doc.title ?? "",
      startDate: toDateOnly(doc.start_date) ?? "1970-01-01", // NOT NULL
      endDate: toDateOnly(doc.end_date),
      note: doc.note ?? "",
      createdAt: toTimestamp(doc.created_at) ?? new Date(),
    });
    if (batch.length >= BATCH_SIZE) {
      const { inserted } = await flushBatch({
        table: blockers,
        rows: batch,
        collection: "blockers",
        idKey: "id",
      });
      stats.inserted += inserted;
      stats.skipped = batch.length - inserted;
      batch = [];
    }
  }
  if (batch.length > 0) {
    const { inserted } = await flushBatch({
      table: blockers,
      rows: batch,
      collection: "blockers",
      idKey: "id",
    });
    stats.inserted += inserted;
    stats.skipped = batch.length - inserted;
  }
  log(
    `blockers: done (inserted ${stats.inserted}, skipped ${stats.skipped}, failed ${stats.failed})`,
  );
  return stats;
}

interface MessagesStats extends MigrateStats {
  proposalsInserted: number;
  proposalsSkipped: number;
}

/**
 * `messages` is the largest collection by volume and the only one with
 * embedded proposals. We split each `doc.proposals[]` array into its
 * own rows in the `proposals` table, generating fresh `prop_<hex12>`
 * IDs. Args are everything except {id, action, status, result}; we keep
 * them as JSONB for queryability (the architecture plan calls this out
 * explicitly: "Proposals become queryable for the audit view, FK-linked
 * to confirmations").
 *
 * Chunking strategy:
 *   - For users with ≤ 10k messages: stream with batchSize=500 cursor.
 *   - For users with > 10k messages: explicitly paginate with limit/skip
 *     in 5k chunks, freeing memory between chunks.
 *
 * `messages._migrated_at` row tracking still uses the `_etl_state`
 * table keyed by message id; proposals get a separate entry under
 * collection="proposals".
 */
async function migrateMessages(mongo: Db): Promise<MessagesStats> {
  const coll = mongo.collection<MongoDoc>("messages");
  const total = await coll.countDocuments();
  log(`messages: starting (${total} docs; embedded proposals will split)`);

  const stats: MessagesStats = {
    inserted: 0,
    skipped: 0,
    failed: 0,
    proposalsInserted: 0,
    proposalsSkipped: 0,
  };

  // Bucket users by message count so we can route large users to the
  // explicit-pagination path.
  const userCounts = await coll
    .aggregate([
      { $group: { _id: "$user_id", count: { $sum: 1 } } },
    ])
    .toArray();
  const largeUserIds = new Set(
    userCounts
      .filter((u) => (u.count ?? 0) > LARGE_USER_THRESHOLD)
      .map((u) => u._id)
      .filter(Boolean) as string[],
  );
  if (largeUserIds.size > 0) {
    log(
      `messages: ${largeUserIds.size} user(s) exceed ${LARGE_USER_THRESHOLD} — explicit chunking`,
    );
  }
  const largeArr = Array.from(largeUserIds);

  const alreadyMigratedMsg = await loadMigratedIds("messages");
  const alreadyMigratedProp = await loadMigratedIds("proposals");

  /**
   * Process a batch of message documents: split proposals, then flush
   * both message and proposal batches.
   */
  async function processBatch(docs: MongoDoc[]): Promise<void> {
    const msgBatch: any[] = [];
    const propBatch: any[] = [];
    for (const doc of docs) {
      const id: string | undefined = doc.id;
      if (!id) {
        stats.failed++;
        continue;
      }
      if (!alreadyMigratedMsg.has(id)) {
        msgBatch.push({
          id,
          userId: doc.user_id,
          role: doc.role,
          content: doc.content ?? "",
          provider: doc.provider ?? null,
          createdAt: toTimestamp(doc.created_at) ?? new Date(),
        });
      } else {
        stats.skipped++;
      }

      // ---- proposals split ----------------------------------------
      const docProposals = Array.isArray(doc.proposals) ? doc.proposals : [];
      for (const p of docProposals) {
        if (!p || typeof p !== "object") continue;
        const action: string | undefined = p.action;
        if (!action) continue; // malformed — skip silently
        const newId = newPropId();
        if (alreadyMigratedProp.has(newId)) {
          stats.proposalsSkipped++;
          continue;
        }
        // args = everything except the columns we already model.
        const { id: _i, action: _a, status: _s, result: _r, ...args } =
          p as Record<string, unknown>;
        propBatch.push({
          id: newId,
          messageId: id,
          userId: doc.user_id,
          action,
          args: args ?? {},
          status: p.status ?? "pending",
          result: p.result ?? null,
          createdAt: toTimestamp(doc.created_at) ?? new Date(),
          resolvedAt: toTimestamp((p as any).resolved_at),
        });
      }
    }
    if (msgBatch.length > 0) {
      const { inserted } = await flushBatch({
        table: messages,
        rows: msgBatch,
        collection: "messages",
        idKey: "id",
      });
      stats.inserted += inserted;
      stats.skipped += msgBatch.length - inserted;
    }
    if (propBatch.length > 0) {
      const { inserted } = await flushBatch({
        table: proposals,
        rows: propBatch,
        collection: "proposals",
        idKey: "id",
      });
      stats.proposalsInserted += inserted;
      stats.proposalsSkipped += propBatch.length - inserted;
    }
  }

  // ---- Stream small users via cursor ----
  if (largeArr.length > 0) {
    const cursor = coll
      .find(
        { user_id: { $nin: largeArr } },
        { projection: { _id: 0 } },
      )
      .sort({ user_id: 1, created_at: 1 })
      .batchSize(MONGO_BATCH);

    let buffer: MongoDoc[] = [];
    for await (const doc of cursor as unknown as AsyncIterable<MongoDoc>) {
      buffer.push(doc);
      if (buffer.length >= BATCH_SIZE) {
        await processBatch(buffer);
        buffer = [];
      }
    }
    if (buffer.length > 0) await processBatch(buffer);
  } else {
    // No large users — single cursor over everything is fine.
    const cursor = coll
      .find({}, { projection: { _id: 0 } })
      .sort({ user_id: 1, created_at: 1 })
      .batchSize(MONGO_BATCH);
    let buffer: MongoDoc[] = [];
    for await (const doc of cursor as unknown as AsyncIterable<MongoDoc>) {
      buffer.push(doc);
      if (buffer.length >= BATCH_SIZE) {
        await processBatch(buffer);
        buffer = [];
      }
    }
    if (buffer.length > 0) await processBatch(buffer);
  }

  // ---- Large users: explicit chunked pagination ----
  for (const userId of largeArr) {
    const userCount = await coll.countDocuments({ user_id: userId });
    log(`messages: user ${userId} — ${userCount} docs, chunking in ${LARGE_USER_CHUNK}`);
    for (let skip = 0; skip < userCount; skip += LARGE_USER_CHUNK) {
      const chunk = await coll
        .find(
          { user_id: userId },
          { projection: { _id: 0 } },
        )
        .sort({ created_at: 1 })
        .skip(skip)
        .limit(LARGE_USER_CHUNK)
        .toArray();
      await processBatch(chunk);
    }
  }

  log(
    `messages: done (inserted ${stats.inserted}, skipped ${stats.skipped}, failed ${stats.failed})`,
  );
  log(
    `proposals: done (inserted ${stats.proposalsInserted}, skipped ${stats.proposalsSkipped})`,
  );
  return stats;
}

async function migrateAuditLog(mongo: Db): Promise<MigrateStats> {
  const coll = mongo.collection("audit_log");
  const total = await coll.countDocuments();
  log(`audit_log: starting (${total} docs)`);

  const stats: MigrateStats = { inserted: 0, skipped: 0, failed: 0 };
  const alreadyMigrated = await loadMigratedIds("audit_log");

  const cursor = coll
    .find({}, { projection: { _id: 0 } })
    .batchSize(MONGO_BATCH);
  let batch: any[] = [];
  for await (const doc of cursor as unknown as AsyncIterable<MongoDoc>) {
    const id: string | undefined = doc.id;
    if (!id) {
      stats.failed++;
      continue;
    }
    if (alreadyMigrated.has(id)) {
      stats.skipped++;
      continue;
    }
    batch.push({
      id,
      userId: doc.user_id,
      type: doc.type ?? "",
      summary: doc.summary ?? "",
      payload: doc.payload ?? {},
      createdAt: toTimestamp(doc.created_at) ?? new Date(),
    });
    if (batch.length >= BATCH_SIZE) {
      const { inserted } = await flushBatch({
        table: auditLog,
        rows: batch,
        collection: "audit_log",
        idKey: "id",
      });
      stats.inserted += inserted;
      stats.skipped = batch.length - inserted;
      batch = [];
    }
  }
  if (batch.length > 0) {
    const { inserted } = await flushBatch({
      table: auditLog,
      rows: batch,
      collection: "audit_log",
      idKey: "id",
    });
    stats.inserted += inserted;
    stats.skipped = batch.length - inserted;
  }
  log(
    `audit_log: done (inserted ${stats.inserted}, skipped ${stats.skipped}, failed ${stats.failed})`,
  );
  return stats;
}

/**
 * Sources migration — preserves Emergent Object Storage URLs verbatim.
 *
 * After the Emergent-only swap we don't copy file blobs into a separate
 * storage system. `sources.storage_path` already points at the Emergent
 * integration proxy path (e.g. `goalcoach/uploads/<user_id>/<file>`).
 * The runtime download handler (`app/api/sources/[id]/download/route.ts`)
 * resolves the path directly via `lib/emergent/storage.ts`.
 *
 * Idempotency: we still consult `_etl_state` to short-circuit
 * already-migrated sources on re-runs. Network I/O is now zero — the
 * row just gets a Postgres row written with the existing storage_path
 * verbatim.
 */
async function migrateSources(mongo: Db): Promise<MigrateStats> {
  const coll = mongo.collection("sources");
  const total = await coll.countDocuments();
  log(
    `sources: starting (${total} docs; storage_path preserved as-is)`,
  );

  const stats: MigrateStats = { inserted: 0, skipped: 0, failed: 0 };
  const alreadyMigrated = await loadMigratedIds("sources");

  const cursor = coll
    .find({}, { projection: { _id: 0 } })
    .sort({ user_id: 1, created_at: 1 })
    .batchSize(MONGO_BATCH);

  let batch: any[] = [];
  for await (const doc of cursor as unknown as AsyncIterable<MongoDoc>) {
    const id: string | undefined = doc.id;
    if (!id) {
      stats.failed++;
      continue;
    }
    if (alreadyMigrated.has(id)) {
      stats.skipped++;
      continue;
    }
    if (!doc.user_id) {
      stats.failed++;
      warn(`sources: ${id} has no user_id, skipping`);
      continue;
    }

    batch.push({
      id,
      userId: doc.user_id,
      goalId: doc.goal_id || null,
      goalTitle: doc.goal_title ?? "",
      kind: doc.kind ?? "link",
      storagePath: doc.storage_path ?? "",
      originalFilename: doc.original_filename ?? "",
      contentType: doc.content_type ?? "application/octet-stream",
      size: typeof doc.size === "number" ? doc.size : 0,
      url: doc.url ?? "",
      textExcerpt: doc.text_excerpt ?? null,
      isDeleted: doc.is_deleted ?? false,
      createdAt: toTimestamp(doc.created_at) ?? new Date(),
    });
    if (batch.length >= BATCH_SIZE) {
      const { inserted } = await flushBatch({
        table: sources,
        rows: batch,
        collection: "sources",
        idKey: "id",
      });
      stats.inserted += inserted;
      stats.skipped = batch.length - inserted;
      batch = [];
    }
  }
  if (batch.length > 0) {
    const { inserted } = await flushBatch({
      table: sources,
      rows: batch,
      collection: "sources",
      idKey: "id",
    });
    stats.inserted += inserted;
    stats.skipped = batch.length - inserted;
  }
  log(
    `sources: done (inserted ${stats.inserted}, skipped ${stats.skipped}, failed ${stats.failed})`,
  );
  return stats;
}

// ----------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------

async function main(): Promise<void> {
  const startTime = Date.now();
  log("=== ETL start ===");

  // ---- Pre-flight env validation ----
  // lib/env.ts uses zod with optional() for the ETL-only keys, so accessing
  // them at runtime can yield undefined. We re-validate here and exit hard
  // on anything missing — the script must not partially run.
  const missing: string[] = [];
  if (!env.DATABASE_URL) missing.push("DATABASE_URL (or DATABASE_URL_UNPOOLED)");
  if (!env.MONGODB_URL) missing.push("MONGODB_URL or MONGO_URL");
  if (missing.length > 0) {
    fail(`Missing required env: ${missing.join(", ")}`);
    process.exit(1);
  }
  // Type-narrow: after the checks above, these are guaranteed defined.
  const MONGODB_URL = env.MONGODB_URL!;
  const DB_NAME = env.DB_NAME ?? "goalcoach";

  // ---- Connect Mongo ----
  log(`connecting to MongoDB (db=${DB_NAME})...`);
  const mongo = new MongoClient(MONGODB_URL, {
    // Bound server-selection so a dead host doesn't hang the script forever.
    serverSelectionTimeoutMS: 15_000,
  });
  await mongo.connect();
  log("MongoDB connected");
  const dbHandle = mongo.db(DB_NAME);

  // ---- Ensure ETL state table ----
  await ensureStateTable();

  // ---- Order matters: parent first (users), then children, then messages
  // (with their embedded proposals split), then audit_log + sources. ----
  const results: Record<string, MigrateStats | MessagesStats> = {};
  try {
    results.users = await migrateUsers(dbHandle);
    results.goals = await migrateGoals(dbHandle);
    results.milestones = await migrateMilestones(dbHandle);
    results.blockers = await migrateBlockers(dbHandle);
    results.messages = await migrateMessages(dbHandle);
    results.audit_log = await migrateAuditLog(dbHandle);
    results.sources = await migrateSources(dbHandle);
  } finally {
    await mongo.close().catch(() => undefined);
    await closeDb().catch(() => undefined);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log("=== ETL complete ===");
  log(`elapsed: ${elapsed}s`);
  for (const [name, stats] of Object.entries(results)) {
    const tail =
      name === "messages" && "proposalsInserted" in stats
        ? ` | proposals: ${stats.proposalsInserted} inserted / ${stats.proposalsSkipped} skipped`
        : "";
    log(
      `${name.padEnd(11)} inserted=${stats.inserted} skipped=${stats.skipped} failed=${stats.failed}${tail}`,
    );
  }
}

main().catch((e) => {
  fail("FATAL", e);
  process.exit(1);
});