-- Sutra: everything new since the last deploy, as ONE script for the Supabase SQL editor.
--
-- Equivalent to running these Alembic migrations in order:
--   20261015_1200_user_prefs      users.preferences
--   20261015_1300_plan_item_desc  plan_items.description
--   20261015_1400_plan_why        plan_items.why, timetable_blocks.why
--   20261015_1500_goal_progress   goal_progress table
--   20261015_1600_done_hours      plan_items.done_hours
--
-- Additive only: nothing is dropped, renamed or rewritten. Safe to run more than once (every statement is
-- IF NOT EXISTS). Take a backup first anyway.
--
-- BEFORE running, check what the database is at:   select version_num from alembic_version;
-- It should be one of the revisions listed in the last UPDATE below (or 20261015_1100_calendar_subs).

BEGIN;

ALTER TABLE users            ADD COLUMN IF NOT EXISTS preferences JSONB DEFAULT '{}'::jsonb NOT NULL;

ALTER TABLE plan_items       ADD COLUMN IF NOT EXISTS description VARCHAR;
ALTER TABLE plan_items       ADD COLUMN IF NOT EXISTS why         VARCHAR;
ALTER TABLE plan_items       ADD COLUMN IF NOT EXISTS done_hours  FLOAT;
ALTER TABLE timetable_blocks ADD COLUMN IF NOT EXISTS why         VARCHAR;

CREATE TABLE IF NOT EXISTS goal_progress (
    goal_id    VARCHAR NOT NULL,
    user_id    VARCHAR NOT NULL,
    digest     VARCHAR NOT NULL,
    verdict    JSONB   DEFAULT '{}' NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
    CONSTRAINT goal_progress_pkey PRIMARY KEY (goal_id),
    CONSTRAINT goal_progress_goal_id_fkey FOREIGN KEY (goal_id) REFERENCES goals (id) ON DELETE CASCADE,
    CONSTRAINT goal_progress_user_id_fkey FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS goal_progress_user_idx ON goal_progress (user_id);

-- Tell Alembic where the database is now, so a later `alembic upgrade head` does not try to repeat these.
-- Only moves a version that is part of this chain; anything else is left alone.
UPDATE alembic_version
   SET version_num = '20261015_1600_done_hours'
 WHERE version_num IN ('20261015_1100_calendar_subs', '20261015_1200_user_prefs', '20261015_1300_plan_item_desc',
                       '20261015_1400_plan_why', '20261015_1500_goal_progress');

COMMIT;

-- Check (run after): all five lines should say true, and the version should be 20261015_1600_done_hours.
SELECT
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users'            AND column_name='preferences') AS users_preferences,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='plan_items'       AND column_name='description') AS plan_items_description,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='plan_items'       AND column_name='why')         AS plan_items_why,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='plan_items'       AND column_name='done_hours')  AS plan_items_done_hours,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='timetable_blocks' AND column_name='why')         AS timetable_blocks_why,
  EXISTS (SELECT 1 FROM information_schema.tables  WHERE table_name='goal_progress')                                  AS goal_progress_table,
  (SELECT version_num FROM alembic_version) AS alembic_version;
