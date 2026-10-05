-- Slice 0 — commitments removed; per-weekday availability added.
--
-- Made idempotent on purpose: Drizzle's generated SQL is not, and this
-- migration can be re-run after a partial apply (e.g. the column already
-- exists from an earlier `db:push`, or the table was already dropped).
DROP TABLE IF EXISTS "commitments" CASCADE;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "availability" jsonb DEFAULT '{}'::jsonb NOT NULL;
