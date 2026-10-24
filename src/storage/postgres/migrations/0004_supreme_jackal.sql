CREATE TABLE "person_tokens" (
	"person_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "people" DROP CONSTRAINT "people_token_hash_unique";--> statement-breakpoint
ALTER TABLE "person_tokens" ADD CONSTRAINT "person_tokens_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
INSERT INTO "person_tokens" ("person_id","token_hash") SELECT "id","token_hash" FROM "people";--> statement-breakpoint
ALTER TABLE "people" DROP COLUMN "token_hash";