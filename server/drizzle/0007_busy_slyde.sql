CREATE TABLE "threshold_types" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"unit" text DEFAULT '' NOT NULL,
	"scale_param" text,
	"builtin" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "threshold_types_key_unique" UNIQUE("key")
);
--> statement-breakpoint
ALTER TABLE "comp_plans" ALTER COLUMN "tiers" SET DEFAULT '{"mode":"marginal","basis":"amount","scaleParam":null,"rows":[]}'::jsonb;