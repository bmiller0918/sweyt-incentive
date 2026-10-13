CREATE TABLE "payroll_templates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"employee_type_id" uuid,
	"definition" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payroll_templates" ADD CONSTRAINT "payroll_templates_employee_type_id_employee_types_id_fk" FOREIGN KEY ("employee_type_id") REFERENCES "public"."employee_types"("id") ON DELETE set null ON UPDATE no action;