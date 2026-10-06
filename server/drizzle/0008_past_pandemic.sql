CREATE TABLE "import_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"child_import_id" uuid NOT NULL,
	"parent_import_id" uuid NOT NULL,
	"child_key" text NOT NULL,
	"parent_key" text NOT NULL,
	"parent_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"aggregates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "import_links_child_import_id_unique" UNIQUE("child_import_id")
);
--> statement-breakpoint
ALTER TABLE "import_links" ADD CONSTRAINT "import_links_child_import_id_imports_id_fk" FOREIGN KEY ("child_import_id") REFERENCES "public"."imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_links" ADD CONSTRAINT "import_links_parent_import_id_imports_id_fk" FOREIGN KEY ("parent_import_id") REFERENCES "public"."imports"("id") ON DELETE cascade ON UPDATE no action;