-- Migration 20261015_2000_plan_status, idempotent, for the Supabase SQL editor. Run after 20261015_done_at.sql.
BEGIN;
ALTER TABLE goals ADD COLUMN IF NOT EXISTS plan_status VARCHAR;
ALTER TABLE goals ADD COLUMN IF NOT EXISTS plan_started_at TIMESTAMPTZ;
UPDATE alembic_version SET version_num = '20261015_2000_plan_status' WHERE version_num = '20261015_1900_done_at';
COMMIT;

-- Check: two trues, version 20261015_2000_plan_status.
SELECT
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='goals' AND column_name='plan_status')     AS goals_plan_status,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='goals' AND column_name='plan_started_at') AS goals_plan_started_at,
  (SELECT version_num FROM alembic_version) AS alembic_version;
