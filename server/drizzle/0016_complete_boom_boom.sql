ALTER TABLE "amortization_assets" DROP CONSTRAINT "amortization_assets_period_id_accounting_periods_id_fk";
--> statement-breakpoint
ALTER TABLE "amortization_assets" ALTER COLUMN "period_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "amortization_assets" ALTER COLUMN "booked_month" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "amortization_assets" ADD COLUMN "number" serial NOT NULL;--> statement-breakpoint
ALTER TABLE "amortization_assets" ADD COLUMN "origin" text DEFAULT 'commission' NOT NULL;--> statement-breakpoint
ALTER TABLE "amortization_assets" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "amortization_assets" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "amortization_assets" ADD COLUMN "type_id" uuid;--> statement-breakpoint
ALTER TABLE "amortization_assets" ADD COLUMN "method_id" uuid;--> statement-breakpoint
ALTER TABLE "amortization_assets" ADD COLUMN "opening" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "amortization_assets" ADD COLUMN "offset_account" jsonb;--> statement-breakpoint
ALTER TABLE "amortization_assets" ADD COLUMN "history" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "amortization_assets" ADD CONSTRAINT "amortization_assets_period_id_accounting_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."accounting_periods"("id") ON DELETE set null ON UPDATE no action;