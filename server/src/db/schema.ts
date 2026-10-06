import { randomUUID } from 'node:crypto';
import { doublePrecision, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { Aggregate, ColumnDef, Criteria, PlanTiers, RawRow } from '@commissions/shared';

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

/**
 * Parent/child relationship between imports on a key column. The child's
 * rows gain the parent's fields; the parent's rows gain roll-ups of the
 * child's rows. One parent per child; a parent may have many children.
 */
export const importLinks = pgTable('import_links', {
  ...base,
  childImportId: uuid('child_import_id')
    .notNull()
    .unique()
    .references(() => imports.id, { onDelete: 'cascade' }),
  parentImportId: uuid('parent_import_id')
    .notNull()
    .references(() => imports.id, { onDelete: 'cascade' }),
  /** Key column in the child, e.g. "Deal ID". */
  childKey: text('child_key').notNull(),
  /** Key column in the parent, e.g. "ID". */
  parentKey: text('parent_key').notNull(),
  /** Parent columns to expose on the child; empty = all. */
  parentFields: jsonb('parent_fields').$type<string[]>().notNull().default([]),
  /** Roll-ups of child rows exposed on the parent. */
  aggregates: jsonb('aggregates').$type<Aggregate[]>().notNull().default([]),
});

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

/** What a tier table's thresholds are measured in. Built-ins are seeded; users add more. */
export const thresholdTypes = pgTable('threshold_types', {
  ...base,
  /** Stable key stored on plans (e.g. 'amount', 'calls'). */
  key: text('key').notNull().unique(),
  name: text('name').notNull(),
  /** Display unit, e.g. '$', '%', 'calls'. */
  unit: text('unit').notNull().default(''),
  /** When set, thresholds are fractions of this plan parameter (e.g. 'quota'). */
  scaleParam: text('scale_param'),
  builtin: integer('builtin').notNull().default(0),
});

/** A compensation plan: named parameters formulas can reference as plan.<key>. */
export const compPlans = pgTable('comp_plans', {
  ...base,
  name: text('name').notNull(),
  description: text('description'),
  params: jsonb('params').$type<Record<string, number | string | boolean | null>>().notNull().default({}),
  /** Tier table used by TIER() / TIER_RATE() in formulas. */
  tiers: jsonb('tiers').$type<PlanTiers>().notNull().default({ mode: 'marginal', basis: 'amount', scaleParam: null, rows: [] }),
  /** YYYY-MM-DD; null = open-ended. */
  effectiveFrom: text('effective_from'),
  effectiveTo: text('effective_to'),
});

/** A role (Enterprise AE, SDR, ...) carrying default plan assignments and defaults. */
export const employeeTypes = pgTable('employee_types', {
  ...base,
  name: text('name').notNull(),
  description: text('description'),
  defaultBaseSalary: doublePrecision('default_base_salary'),
  defaultQuota: doublePrecision('default_quota'),
});

/** Default plan for a slot, for every employee of a type (unless they override it). */
export const typePlanAssignments = pgTable(
  'type_plan_assignments',
  {
    ...base,
    employeeTypeId: uuid('employee_type_id')
      .notNull()
      .references(() => employeeTypes.id, { onDelete: 'cascade' }),
    compPlanId: uuid('comp_plan_id')
      .notNull()
      .references(() => compPlans.id, { onDelete: 'cascade' }),
    slot: text('slot').notNull().default('plan'),
    effectiveFrom: text('effective_from'),
    effectiveTo: text('effective_to'),
  },
  (t) => [index('type_plan_assignments_type_idx').on(t.employeeTypeId)],
);

/** A person who earns commission. `name` must match the rep column in the data. */
export const employees = pgTable(
  'employees',
  {
    ...base,
    name: text('name').notNull(),
    title: text('title'),
    email: text('email'),
    employeeTypeId: uuid('employee_type_id').references(() => employeeTypes.id, { onDelete: 'set null' }),
    baseSalary: doublePrecision('base_salary'),
    /** Per-person quota; overrides the type default and the plan's quota param. */
    quota: doublePrecision('quota'),
    /** Named recurring/fixed bonuses: [{label, amount}]. */
    bonuses: jsonb('bonuses').$type<{ label: string; amount: number }[]>().notNull().default([]),
    notes: text('notes'),
    startDate: text('start_date'),
    /** Kept for history; the UI uses status + statusDate instead. */
    endDate: text('end_date'),
    /** active | terminated | parental_leave | medical_leave | leave | inactive */
    status: text('status').notNull().default('active'),
    /** When the current status began (e.g. termination date). */
    statusDate: text('status_date'),
  },
  (t) => [index('employees_name_idx').on(t.name)],
);

/**
 * An employee's plan for a slot ("plan" = core plan; "spiff", "bonus", ...
 * for extras). Formulas reference a slot's parameters as <slot>.<param>.
 */
export const planAssignments = pgTable(
  'plan_assignments',
  {
    ...base,
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'cascade' }),
    compPlanId: uuid('comp_plan_id')
      .notNull()
      .references(() => compPlans.id, { onDelete: 'cascade' }),
    slot: text('slot').notNull().default('plan'),
    effectiveFrom: text('effective_from'),
    effectiveTo: text('effective_to'),
  },
  (t) => [index('plan_assignments_employee_idx').on(t.employeeId)],
);

export const auditLog = pgTable('audit_log', {
  ...base,
  actor: text('actor').notNull().default('system'),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id'),
  detail: jsonb('detail').$type<Record<string, unknown>>(),
});
