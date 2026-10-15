-- Migration 20261015_1800_todo_fields, idempotent, for the Supabase SQL editor.
-- Run after 20261015_milestone_tree.sql.
BEGIN;
ALTER TABLE plan_items ADD COLUMN IF NOT EXISTS item_type VARCHAR;
ALTER TABLE plan_items ADD COLUMN IF NOT EXISTS priority VARCHAR;
ALTER TABLE plan_items ADD COLUMN IF NOT EXISTS due_time TIME;
UPDATE alembic_version SET version_num = '20261015_1800_todo_fields' WHERE version_num = '20261015_1700_milestone_tree';
COMMIT;

-- Check: three trues, version 20261015_1800_todo_fields.
SELECT
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='plan_items' AND column_name='item_type') AS plan_items_item_type,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='plan_items' AND column_name='priority')  AS plan_items_priority,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='plan_items' AND column_name='due_time')  AS plan_items_due_time,
  (SELECT version_num FROM alembic_version) AS alembic_version;
