DROP TABLE "commitments" CASCADE;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "availability" jsonb DEFAULT '{}'::jsonb NOT NULL;