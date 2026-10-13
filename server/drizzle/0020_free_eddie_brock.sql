ALTER TABLE "comp_plans" ADD COLUMN "employee_type_id" uuid;--> statement-breakpoint
ALTER TABLE "comp_plans" ADD COLUMN "quotas" jsonb;--> statement-breakpoint
ALTER TABLE "comp_plans" ADD CONSTRAINT "comp_plans_employee_type_id_employee_types_id_fk" FOREIGN KEY ("employee_type_id") REFERENCES "public"."employee_types"("id") ON DELETE set null ON UPDATE no action;