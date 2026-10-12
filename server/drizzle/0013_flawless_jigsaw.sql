CREATE TABLE "accounting_periods" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"month" text NOT NULL,
	"run_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"entries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"booked_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"current_portion" double precision DEFAULT 0 NOT NULL,
	"closed_by" text,
	CONSTRAINT "accounting_periods_month_unique" UNIQUE("month")
);
--> statement-breakpoint
CREATE TABLE "amortization_assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"period_id" uuid NOT NULL,
	"source_key" text NOT NULL,
	"run_id" uuid,
	"line_id" integer,
	"deal_key" text,
	"payee" text NOT NULL,
	"department" text NOT NULL,
	"type_name" text NOT NULL,
	"method_name" text NOT NULL,
	"amount" double precision NOT NULL,
	"capitalized_month" text NOT NULL,
	"booked_month" text NOT NULL,
	"start_month" text NOT NULL,
	"end_month" text NOT NULL,
	"months" integer NOT NULL,
	"by_month" jsonb NOT NULL,
	"amortization_account" jsonb,
	"written_off_month" text,
	"write_off_reason" text
);
--> statement-breakpoint
CREATE TABLE "amortization_methods" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"def" jsonb NOT NULL,
	"builtin_key" text
);
--> statement-breakpoint
CREATE TABLE "amortization_types" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"treatment" text DEFAULT 'capitalize' NOT NULL,
	"method_id" uuid,
	"expense_account" jsonb,
	"amortization_account" jsonb,
	"builtin_key" text,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounting_policy" ADD COLUMN "default_method_id" uuid;--> statement-breakpoint
ALTER TABLE "accounting_policy" ADD COLUMN "practical_expedient" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "accounting_policy" ADD COLUMN "reclass_enabled" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "accounting_policy" ADD COLUMN "reclass_mode" text DEFAULT 'true_up' NOT NULL;--> statement-breakpoint
ALTER TABLE "accounting_policy" ADD COLUMN "accounts" jsonb;--> statement-breakpoint
ALTER TABLE "employee_types" ADD COLUMN "amortization_type_id" uuid;--> statement-breakpoint
ALTER TABLE "amortization_assets" ADD CONSTRAINT "amortization_assets_period_id_accounting_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."accounting_periods"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amortization_types" ADD CONSTRAINT "amortization_types_method_id_amortization_methods_id_fk" FOREIGN KEY ("method_id") REFERENCES "public"."amortization_methods"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "amortization_assets_booked_idx" ON "amortization_assets" USING btree ("booked_month");--> statement-breakpoint
CREATE INDEX "amortization_assets_source_idx" ON "amortization_assets" USING btree ("source_key");--> statement-breakpoint
ALTER TABLE "accounting_policy" ADD CONSTRAINT "accounting_policy_default_method_id_amortization_methods_id_fk" FOREIGN KEY ("default_method_id") REFERENCES "public"."amortization_methods"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_types" ADD CONSTRAINT "employee_types_amortization_type_id_amortization_types_id_fk" FOREIGN KEY ("amortization_type_id") REFERENCES "public"."amortization_types"("id") ON DELETE set null ON UPDATE no action;