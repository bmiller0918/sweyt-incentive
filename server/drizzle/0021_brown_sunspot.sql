CREATE TABLE "incentive_programs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"kind" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"import_id" uuid,
	"employee_type_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"effective_from" text,
	"effective_to" text,
	"definition" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "incentive_programs" ADD CONSTRAINT "incentive_programs_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE set null ON UPDATE no action;