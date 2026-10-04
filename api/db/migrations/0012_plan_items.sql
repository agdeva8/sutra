-- Iteration 10.2 (multi-horizon execution) — canonical persisted plan.
--
-- plan_items is THE schedule of record. One row per horizon item, all five
-- levels in one table (yearly = the goal span, quarterly = phase spans,
-- monthly = milestones, weekly = derived checkpoints, daily = commitments).
-- The scheduler (`lib/goal-planner/scheduler.ts`) computes the rows; the
-- proposal executor writes them on confirm, keyed to the goal that was just
-- created/edited. `milestones` / `commitments` remain the user-facing tick
-- surfaces; plan_items is what the execution dashboard renders.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + guarded constraints, so it is
-- safe to re-run on a DB that already has the table (e.g. after a re-apply).

CREATE TABLE IF NOT EXISTS "plan_items" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"goal_id" text,
	"horizon" text NOT NULL,
	"phase" text DEFAULT '' NOT NULL,
	"title" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"start_date" date,
	"end_date" date,
	"due_date" date,
	"weekly_hours" integer,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "plan_items" ADD CONSTRAINT "plan_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "plan_items" ADD CONSTRAINT "plan_items_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plan_items_user_horizon_idx" ON "plan_items" USING btree ("user_id","horizon","start_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plan_items_goal_idx" ON "plan_items" USING btree ("goal_id");
