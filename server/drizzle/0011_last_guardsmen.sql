CREATE TABLE "accounting_policy" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"method" text DEFAULT 'contract_term' NOT NULL,
	"customer_life_months" integer DEFAULT 48 NOT NULL,
	"default_term_months" integer DEFAULT 12 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "commission_lines" ADD COLUMN "contract_start" text;--> statement-breakpoint
ALTER TABLE "commission_lines" ADD COLUMN "term_months" double precision;--> statement-breakpoint
ALTER TABLE "employee_types" ADD COLUMN "cost_treatment" text DEFAULT 'capitalize' NOT NULL;