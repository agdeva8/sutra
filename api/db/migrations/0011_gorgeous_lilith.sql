ALTER TABLE "sources" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "sources_expires_at_idx" ON "sources" USING btree ("expires_at");