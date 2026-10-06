import { randomUUID } from 'node:crypto';
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { ColumnDef, Criteria, RawRow } from '@commissions/shared';

// Every table carries timestamps and a nullable organization_id so multi-
// tenancy can be added later without a migration of existing rows.
const base = {
  id: uuid('id')
    .primaryKey()
    .$defaultFn(() => randomUUID()),
  organizationId: uuid('organization_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

export const imports = pgTable('imports', {
  ...base,
  name: text('name').notNull(),
  filename: text('filename').notNull(),
  sheetName: text('sheet_name'),
  headerRow: integer('header_row').notNull().default(0),
  rowCount: integer('row_count').notNull().default(0),
  columns: jsonb('columns').$type<ColumnDef[]>().notNull(),
  /** Data-quality warnings surfaced at import time. */
  warnings: jsonb('warnings').$type<string[]>().notNull().default([]),
});

export const importRows = pgTable(
  'import_rows',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    importId: uuid('import_id')
      .notNull()
      .references(() => imports.id, { onDelete: 'cascade' }),
    rowIndex: integer('row_index').notNull(),
    data: jsonb('data').$type<RawRow>().notNull(),
  },
  (t) => [index('import_rows_import_idx').on(t.importId, t.rowIndex)],
);

export const criteriaSets = pgTable('criteria_sets', {
  ...base,
  name: text('name').notNull(),
  description: text('description'),
  /** Optional: the import this was built against (fields may not exist elsewhere). */
  importId: uuid('import_id').references(() => imports.id, { onDelete: 'set null' }),
  criteria: jsonb('criteria').$type<Criteria>().notNull(),
  version: integer('version').notNull().default(1),
});

export const criteriaVersions = pgTable('criteria_versions', {
  ...base,
  criteriaSetId: uuid('criteria_set_id')
    .notNull()
    .references(() => criteriaSets.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  criteria: jsonb('criteria').$type<Criteria>().notNull(),
});

/** Maps file headers to canonical fields Phase 2 will use (rep, amount, ...). */
export const canonicalMappings = pgTable('canonical_mappings', {
  ...base,
  importId: uuid('import_id')
    .notNull()
    .references(() => imports.id, { onDelete: 'cascade' }),
  mapping: jsonb('mapping').$type<Record<string, string>>().notNull(),
});

export const auditLog = pgTable('audit_log', {
  ...base,
  actor: text('actor').notNull().default('system'),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id'),
  detail: jsonb('detail').$type<Record<string, unknown>>(),
});
