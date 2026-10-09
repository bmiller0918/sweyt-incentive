CREATE TABLE "commission_lines" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "commission_lines_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"run_id" uuid NOT NULL,
	"row_index" integer NOT NULL,
	"deal_key" text,
	"deal_date" text,
	"deal_amount" double precision,
	"payee" text NOT NULL,
	"role" text NOT NULL,
	"plan_name" text,
	"method" text NOT NULL,
	"tier_from" double precision,
	"tier_to" double precision,
	"amount" double precision,
	"rate" double precision,
	"payout" double precision,
	"cumulative_before" double precision DEFAULT 0 NOT NULL,
	"cumulative_after" double precision DEFAULT 0 NOT NULL,
	"split" integer DEFAULT 0 NOT NULL,
	"note" text,
	"status" text DEFAULT 'calculated' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commission_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"import_id" uuid,
	"import_name" text NOT NULL,
	"config" jsonb NOT NULL,
	"deal_count" integer DEFAULT 0 NOT NULL,
	"line_count" integer DEFAULT 0 NOT NULL,
	"total_payout" double precision DEFAULT 0 NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "commission_lines" ADD CONSTRAINT "commission_lines_run_id_commission_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."commission_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_runs" ADD CONSTRAINT "commission_runs_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commission_lines_run_idx" ON "commission_lines" USING btree ("run_id","row_index");--> statement-breakpoint
CREATE INDEX "commission_lines_payee_idx" ON "commission_lines" USING btree ("run_id","payee");