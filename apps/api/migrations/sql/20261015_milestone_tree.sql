-- Migration 20261015_1700_milestone_tree, idempotent, for the Supabase SQL editor.
-- Run after 20261015_supabase_upgrade.sql.
BEGIN;
ALTER TABLE milestones ADD COLUMN IF NOT EXISTS parent_id VARCHAR REFERENCES milestones(id) ON DELETE SET NULL;
ALTER TABLE milestones ADD COLUMN IF NOT EXISTS hours DOUBLE PRECISION;
ALTER TABLE plan_items ADD COLUMN IF NOT EXISTS milestone_id VARCHAR;
UPDATE alembic_version SET version_num = '20261015_1700_milestone_tree' WHERE version_num = '20261015_1600_done_hours';
COMMIT;

-- Check: three trues, version 20261015_1700_milestone_tree.
SELECT
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='milestones' AND column_name='parent_id')    AS milestones_parent_id,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='milestones' AND column_name='hours')        AS milestones_hours,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='plan_items' AND column_name='milestone_id') AS plan_items_milestone_id,
  (SELECT version_num FROM alembic_version) AS alembic_version;
