CREATE TABLE "comp_plans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"effective_from" text,
	"effective_to" text
);
--> statement-breakpoint
CREATE TABLE "rep_plan_assignments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rep_name" text NOT NULL,
	"comp_plan_id" uuid NOT NULL,
	"effective_from" text,
	"effective_to" text
);
--> statement-breakpoint
ALTER TABLE "rep_plan_assignments" ADD CONSTRAINT "rep_plan_assignments_comp_plan_id_comp_plans_id_fk" FOREIGN KEY ("comp_plan_id") REFERENCES "public"."comp_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rep_plan_assignments_rep_idx" ON "rep_plan_assignments" USING btree ("rep_name");