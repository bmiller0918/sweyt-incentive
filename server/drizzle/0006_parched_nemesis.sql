CREATE TABLE "employee_types" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"default_base_salary" double precision,
	"default_quota" double precision
);
--> statement-breakpoint
CREATE TABLE "type_plan_assignments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"employee_type_id" uuid NOT NULL,
	"comp_plan_id" uuid NOT NULL,
	"slot" text DEFAULT 'plan' NOT NULL,
	"effective_from" text,
	"effective_to" text
);
--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "employee_type_id" uuid;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "quota" double precision;--> statement-breakpoint
ALTER TABLE "type_plan_assignments" ADD CONSTRAINT "type_plan_assignments_employee_type_id_employee_types_id_fk" FOREIGN KEY ("employee_type_id") REFERENCES "public"."employee_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "type_plan_assignments" ADD CONSTRAINT "type_plan_assignments_comp_plan_id_comp_plans_id_fk" FOREIGN KEY ("comp_plan_id") REFERENCES "public"."comp_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "type_plan_assignments_type_idx" ON "type_plan_assignments" USING btree ("employee_type_id");--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_employee_type_id_employee_types_id_fk" FOREIGN KEY ("employee_type_id") REFERENCES "public"."employee_types"("id") ON DELETE set null ON UPDATE no action;