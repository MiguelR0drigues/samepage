ALTER TABLE "people" ADD COLUMN "dashboard_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "dashboard_nonce" text;