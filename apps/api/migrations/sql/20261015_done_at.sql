-- Migration 20261015_1900_done_at, idempotent, for the Supabase SQL editor. Run after 20261015_todo_fields.sql.
BEGIN;
ALTER TABLE plan_items ADD COLUMN IF NOT EXISTS done_at TIMESTAMPTZ;
UPDATE plan_items SET done_at = created_at WHERE status = 'done' AND done_at IS NULL;
UPDATE alembic_version SET version_num = '20261015_1900_done_at' WHERE version_num = '20261015_1800_todo_fields';
COMMIT;

-- Check: true, version 20261015_1900_done_at.
SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='plan_items' AND column_name='done_at') AS plan_items_done_at,
       (SELECT version_num FROM alembic_version) AS alembic_version;
