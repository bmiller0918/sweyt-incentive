ALTER TABLE "amortization_assets" ADD COLUMN "accounts" jsonb;--> statement-breakpoint
ALTER TABLE "amortization_types" ADD COLUMN "accounts" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "amortization_types" ADD COLUMN "default_term_months" integer;--> statement-breakpoint
ALTER TABLE "amortization_types" ADD COLUMN "inactive" boolean DEFAULT false NOT NULL;