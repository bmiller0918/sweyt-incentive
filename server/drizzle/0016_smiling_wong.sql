-- IF NOT EXISTS: an earlier revision of this branch shipped this same table as
-- migration 0013 before main took that number. Databases migrated from that
-- revision already have the table (same shape), so this is a no-op there.
CREATE TABLE IF NOT EXISTS "payout_rules" (
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
