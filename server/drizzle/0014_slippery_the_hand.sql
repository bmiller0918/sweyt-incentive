CREATE TABLE "payout_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"reason_key" text NOT NULL,
	"filters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"requirements" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"require_all" integer DEFAULT 1 NOT NULL,
	"enabled" integer DEFAULT 1 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
