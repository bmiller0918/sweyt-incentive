CREATE TABLE "employees" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"title" text,
	"email" text,
	"base_salary" double precision,
	"bonuses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"start_date" text,
	"end_date" text
);
--> statement-breakpoint
CREATE TABLE "plan_assignments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"employee_id" uuid NOT NULL,
	"comp_plan_id" uuid NOT NULL,
	"slot" text DEFAULT 'plan' NOT NULL,
	"effective_from" text,
	"effective_to" text
);
--> statement-breakpoint
ALTER TABLE "plan_assignments" ADD CONSTRAINT "plan_assignments_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_assignments" ADD CONSTRAINT "plan_assignments_comp_plan_id_comp_plans_id_fk" FOREIGN KEY ("comp_plan_id") REFERENCES "public"."comp_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "employees_name_idx" ON "employees" USING btree ("name");--> statement-breakpoint
CREATE INDEX "plan_assignments_employee_idx" ON "plan_assignments" USING btree ("employee_id");