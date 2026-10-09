CREATE TABLE "hold_reasons" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"builtin" integer DEFAULT 0 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "hold_reasons_key_unique" UNIQUE("key")
);
--> statement-breakpoint
ALTER TABLE "commission_lines" ALTER COLUMN "status" SET DEFAULT 'pay';--> statement-breakpoint
ALTER TABLE "commission_lines" ADD COLUMN "hold_reason" text;--> statement-breakpoint
ALTER TABLE "commission_lines" ADD COLUMN "hold_note" text;--> statement-breakpoint
ALTER TABLE "commission_lines" ADD COLUMN "held_at" text;--> statement-breakpoint
ALTER TABLE "commission_lines" ADD COLUMN "released_at" text;--> statement-breakpoint
ALTER TABLE "commission_lines" ADD COLUMN "pay_month" text;--> statement-breakpoint
UPDATE "commission_lines" SET "status" = 'pay' WHERE "status" = 'calculated';--> statement-breakpoint
UPDATE "commission_lines" SET "pay_month" = to_char((deal_date::date + interval '1 month'), 'YYYY-MM') WHERE "pay_month" IS NULL AND "deal_date" IS NOT NULL;
