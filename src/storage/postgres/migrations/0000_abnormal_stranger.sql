CREATE TABLE "entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"status" text NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"question" text,
	"positions" jsonb,
	"consensus" text,
	"consensus_reason" text,
	"area" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_ref" text,
	"recorded_by" text NOT NULL,
	"updated_by" text,
	"supersedes_id" uuid,
	"target_id" uuid,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" text
);
--> statement-breakpoint
CREATE TABLE "entry_authors" (
	"entry_id" uuid NOT NULL,
	"person_id" text NOT NULL,
	CONSTRAINT "entry_authors_entry_id_person_id_pk" PRIMARY KEY("entry_id","person_id")
);
--> statement-breakpoint
CREATE TABLE "people" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"token_hash" text NOT NULL,
	"last_seen_at" timestamp with time zone,
	CONSTRAINT "people_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_recorded_by_people_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_updated_by_people_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_supersedes_id_entries_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_target_id_entries_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_deleted_by_people_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_authors" ADD CONSTRAINT "entry_authors_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_authors" ADD CONSTRAINT "entry_authors_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;