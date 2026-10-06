// Criteria AST: the JSON that saved criteria sets persist, and that the
// evaluator consumes. Versioned so later schema changes can be migrated.
import { z } from 'zod';
import { RELATIVE_PRESETS } from './dates.js';
import type { ColumnFamily } from './types.js';

export const CRITERIA_SCHEMA_VERSION = 1;

// -- Operators ---------------------------------------------------------------

export const TEXT_OPERATORS = [
  'is',
  'is_not',
  'contains',
  'not_contains',
  'starts_with',
  'ends_with',
  'any_of',
  'none_of',
  'regex',
  'empty',
  'not_empty',
] as const;

export const NUMBER_OPERATORS = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'not_between',
  'any_of',
  'none_of',
  'empty',
  'not_empty',
] as const;

export const DATE_OPERATORS = [
  'on',
  'not_on',
  'before',
  'after',
  'on_or_before',
  'on_or_after',
  'between',
  'not_between',
  'relative',
  'not_relative',
  'empty',
  'not_empty',
] as const;

export const BOOLEAN_OPERATORS = ['is_true', 'is_false', 'empty', 'not_empty'] as const;

export const ALL_OPERATORS = [
  ...new Set<string>([...TEXT_OPERATORS, ...NUMBER_OPERATORS, ...DATE_OPERATORS, ...BOOLEAN_OPERATORS]),
] as const;

export type Operator =
  | (typeof TEXT_OPERATORS)[number]
  | (typeof NUMBER_OPERATORS)[number]
  | (typeof DATE_OPERATORS)[number]
  | (typeof BOOLEAN_OPERATORS)[number];

export const OPERATORS_BY_FAMILY: Record<ColumnFamily, readonly Operator[]> = {
  text: TEXT_OPERATORS,
  number: NUMBER_OPERATORS,
  date: DATE_OPERATORS,
  boolean: BOOLEAN_OPERATORS,
};

export const OPERATOR_LABELS: Record<Operator, string> = {
  is: 'is',
  is_not: 'is not',
  contains: 'contains',
  not_contains: 'does not contain',
  starts_with: 'starts with',
  ends_with: 'ends with',
  any_of: 'is any of',
  none_of: 'is none of',
  regex: 'matches regex',
  empty: 'is empty',
  not_empty: 'is not empty',
  eq: '=',
  neq: '≠',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  between: 'between',
  not_between: 'not between',
  on: 'on',
  not_on: 'not on',
  before: 'before',
  after: 'after',
  on_or_before: 'on or before',
  on_or_after: 'on or after',
  relative: 'is within',
  not_relative: 'is not within',
  is_true: 'is true',
  is_false: 'is false',
};

/** How many value operands an operator takes. */
export function operandArity(op: Operator): 0 | 1 | 2 | 'list' {
  switch (op) {
    case 'empty':
    case 'not_empty':
    case 'is_true':
    case 'is_false':
      return 0;
    case 'between':
    case 'not_between':
      return 2;
    case 'any_of':
    case 'none_of':
      return 'list';
    default:
      return 1;
  }
}

// -- Operands ----------------------------------------------------------------

export const operandSchema = z.discriminatedUnion('kind', [
  // A typed-in value. Stored as text; coerced to the field's type at eval time.
  z.object({ kind: z.literal('literal'), value: z.string() }),
  // Another column in the same row (field-to-field comparison).
  z.object({ kind: z.literal('field'), field: z.string().min(1) }),
  // A named parameter supplied at run time, e.g. {{period_start}}.
  z.object({ kind: z.literal('param'), name: z.string().min(1) }),
  // A relative date preset; only meaningful for date operators.
  z.object({
    kind: z.literal('relative'),
    preset: z.enum(RELATIVE_PRESETS),
    n: z.number().int().positive().optional(),
  }),
]);
export type Operand = z.infer<typeof operandSchema>;

// -- Nodes -------------------------------------------------------------------

export const conditionSchema = z.object({
  type: z.literal('condition'),
  id: z.string().min(1),
  field: z.string().min(1),
  operator: z.enum(ALL_OPERATORS as unknown as [string, ...string[]]),
  values: z.array(operandSchema).default([]),
  caseSensitive: z.boolean().optional(),
  /** Disabled conditions are kept in the tree but ignored by the evaluator. */
  enabled: z.boolean().optional(),
});
export type Condition = z.infer<typeof conditionSchema> & { operator: Operator };

export interface Group {
  type: 'group';
  id: string;
  conjunction: 'and' | 'or';
  not?: boolean;
  children: CriteriaNode[];
}
export type CriteriaNode = Condition | Group;

export const groupSchema: z.ZodType<Group> = z.lazy(() =>
  z.object({
    type: z.literal('group'),
    id: z.string().min(1),
    conjunction: z.enum(['and', 'or']),
    not: z.boolean().optional(),
    children: z.array(z.union([conditionSchema, groupSchema])),
  }),
) as z.ZodType<Group>;

// -- Summary (group by + aggregates + HAVING) ----------------------------------

export const AGG_FNS = ['sum', 'count', 'count_distinct', 'avg', 'min', 'max'] as const;
export type AggFn = (typeof AGG_FNS)[number];

export const AGG_LABELS: Record<AggFn, string> = {
  sum: 'Sum',
  count: 'Count',
  count_distinct: 'Count distinct',
  avg: 'Average',
  min: 'Min',
  max: 'Max',
};

export const aggregateSchema = z.object({
  id: z.string().min(1),
  fn: z.enum(AGG_FNS),
  /** Source column. Not needed for `count` (counts rows). */
  field: z.string().optional(),
  /** Output column name; defaults to e.g. "Sum of Amount". */
  label: z.string().optional(),
});
export type Aggregate = z.infer<typeof aggregateSchema>;

export const summarySchema = z.object({
  groupBy: z.array(z.string()).default([]),
  aggregates: z.array(aggregateSchema).default([]),
  /** Filter applied to the summary rows (fields are the summary's columns). */
  having: groupSchema.optional(),
});
export type SummarySpec = z.infer<typeof summarySchema>;

export function emptySummary(): SummarySpec {
  return { groupBy: [], aggregates: [] };
}

export function isSummaryActive(s: SummarySpec | undefined): s is SummarySpec {
  return !!s && (s.groupBy.length > 0 || s.aggregates.length > 0);
}

export const criteriaSchema = z.object({
  version: z.literal(CRITERIA_SCHEMA_VERSION),
  root: groupSchema,
  /** Default parameter values; callers can override at run time. */
  params: z.record(z.string()).optional(),
  /** Optional second stage: roll the filtered rows up. */
  summary: summarySchema.optional(),
});
export type Criteria = z.infer<typeof criteriaSchema>;

export function emptyCriteria(): Criteria {
  return {
    version: CRITERIA_SCHEMA_VERSION,
    root: { type: 'group', id: 'root', conjunction: 'and', children: [] },
  };
}

/** Depth-first list of every condition in the tree. */
export function listConditions(node: CriteriaNode, out: Condition[] = []): Condition[] {
  if (node.type === 'condition') out.push(node);
  else for (const c of node.children) listConditions(c, out);
  return out;
}

/** Return a copy of the tree with one condition removed (used for impact counts). */
export function withoutCondition(node: Group, id: string): Group {
  return {
    ...node,
    children: node.children
      .filter((c) => !(c.type === 'condition' && c.id === id))
      .map((c) => (c.type === 'group' ? withoutCondition(c, id) : c)),
  };
}
