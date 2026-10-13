// Pay-now / on-hold: a deal is paid on the next payroll unless it trips a
// hold rule (start delayed, can't bill upfront, termination for convenience,
// ...). Held lines wait, with a reason, until someone releases them; a
// released line then pays like a deal that closed on the release date.
import { OPERATOR_LABELS, conditionSchema, type Condition, type Criteria, type Operand, type Operator } from './criteria.js';
import { compileCriteria, isIncomplete, type EvalContext } from './evaluate.js';
import type { TypedRow } from './types.js';
import { z } from 'zod';

/** Reasons every workspace starts with; users add their own. */
export const DEFAULT_HOLD_REASONS = [
  { key: 'start_delayed', name: 'Subscription start delayed more than 4 months' },
  { key: 'no_upfront_billing', name: "Can't bill upfront" },
  { key: 'termination_for_convenience', name: 'Termination-for-convenience clause' },
  { key: 'delayed_payment_terms', name: 'Delayed payment terms' },
  { key: 'other', name: 'Other' },
] as const;

export const LINE_STATUSES = ['pay', 'hold', 'released'] as const;
export type LineStatus = (typeof LINE_STATUSES)[number];
export const LINE_STATUS_LABELS: Record<LineStatus, string> = { pay: 'Pay next payroll', hold: 'On hold', released: 'Released' };

/** One rule: when the deal row matches the condition, hold it for this reason. */
export const holdRuleSchema = z.object({
  id: z.string().min(1),
  reasonKey: z.string().min(1),
  condition: conditionSchema,
});
export type HoldRule = z.infer<typeof holdRuleSchema>;

/** "2026-03-15" + 1 month -> "2026-04". The month a deal closed in, plus the lag. */
export function payMonthFor(dateIso: string | null, lagMonths = 1): string | null {
  const m = dateIso?.match(/^(\d{4})-(\d{2})/);
  if (!m) return null;
  const n = (+m[1] * 12 + (+m[2] - 1)) + lagMonths;
  return `${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, '0')}`;
}

/**
 * Evaluate the rules against each deal row; the first matching rule's
 * reason wins. Rules whose condition isn't filled in yet are ignored, and a
 * rule that fails to compile (unknown column, bad literal) is reported
 * rather than silently skipped.
 */
export function applyHoldRules(rows: TypedRow[], rules: HoldRule[], ctx: EvalContext): { reasons: (string | null)[]; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const compiled: { reasonKey: string; matches: (row: TypedRow) => boolean }[] = [];
  for (const r of rules) {
    const cond = r.condition as Condition;
    if (isIncomplete(cond)) continue;
    const criteria: Criteria = { version: 1, root: { type: 'group', id: `rule:${r.id}`, conjunction: 'and', children: [cond] } };
    try {
      compiled.push({ reasonKey: r.reasonKey, matches: compileCriteria(criteria, ctx).matches });
    } catch (e) {
      errors[r.id] = (e as Error).message;
    }
  }
  const reasons = rows.map((row) => compiled.find((c) => c.matches(row))?.reasonKey ?? null);
  return { reasons, errors };
}

// -- Payout rules -------------------------------------------------------------
//
// Workspace-wide rules in the shape of a cross-validation rule. A rule has
// *filters* (which deals it applies to: "Vendor is Acme"; none = every deal)
// and *requirements* (what must or cannot be true of those deals: "Posted
// Amount cannot be greater than 10,000"). A deal the rule applies to that
// breaks its requirements is flagged: it starts on hold, with the rule's
// reason and message, on every commission run until someone releases it.

export const ENFORCEMENT_DIRECTIONS = ['must', 'cannot'] as const;
export type EnforcementDirection = (typeof ENFORCEMENT_DIRECTIONS)[number];
export const ENFORCEMENT_LABELS: Record<EnforcementDirection, string> = { must: 'Must be', cannot: 'Cannot be' };

/** One requirement: the field must (or cannot) satisfy operator + value. */
export const requirementSchema = conditionSchema.extend({
  direction: z.enum(ENFORCEMENT_DIRECTIONS).default('must'),
});
export type Requirement = z.infer<typeof requirementSchema> & { operator: Operator };

export const payoutRuleSchema = z.object({
  id: z.string().min(1),
  name: z.string().default(''),
  /** Shown on the held line, e.g. "Billing terms must be upfront". Defaults to the requirements in words. */
  message: z.string().default(''),
  reasonKey: z.string().min(1),
  /** Which deals the rule applies to (all must match). Empty = every deal. */
  filters: z.array(conditionSchema).default([]),
  requirements: z.array(requirementSchema).default([]),
  /** true: a deal passes only if every requirement holds. false: passing any one is enough. */
  requireAll: z.boolean().default(true),
  enabled: z.boolean().default(true),
});
export type PayoutRule = z.infer<typeof payoutRuleSchema>;

export interface PayoutRuleHit {
  ruleId: string;
  ruleName: string;
  reasonKey: string;
  /** The hold note for the line: the rule's message, or its requirements in words. */
  message: string;
}

export interface PayoutRulesResult {
  /** Per row: the first rule that flagged it, or null. */
  hits: (PayoutRuleHit | null)[];
  /** Per row: every rule that flagged it (ids), for review screens. */
  allHits: string[][];
  /** Rule id -> rows it flags (counting every rule, not just the first). Only rules that ran. */
  counts: Record<string, number>;
  /** Rule id -> why it couldn't compile against this data (bad literal, ...). */
  errors: Record<string, string>;
  /** Rules naming a column this data doesn't have; skipped, not failed. */
  skipped: string[];
}

const describeOperand = (v: Operand) => (v.kind === 'literal' ? v.value : v.kind === 'field' ? `[${v.field}]` : v.kind === 'param' ? `{{${v.name}}}` : v.n !== undefined ? `${v.preset.replace('_n_', ` ${v.n} `)}` : v.preset);

/** A condition in words: `Billing is Upfront`. */
export function describeCondition(cond: Condition): string {
  const label = OPERATOR_LABELS[cond.operator] ?? cond.operator;
  const vals = cond.values.map(describeOperand).filter((s) => s !== '');
  return [cond.field, label, ...vals].join(' ').trim();
}

/** Operator words that read after "must be" / "cannot be": `Amount cannot be greater than 10000`. */
export const REQUIREMENT_WORDS: Record<Operator, string> = {
  is: 'equal to',
  is_not: 'other than',
  eq: 'equal to',
  neq: 'other than',
  gt: 'greater than',
  gte: 'at least',
  lt: 'less than',
  lte: 'at most',
  contains: 'containing',
  not_contains: 'without',
  starts_with: 'starting with',
  ends_with: 'ending with',
  any_of: 'any of',
  none_of: 'none of',
  regex: 'matching',
  empty: 'empty',
  not_empty: 'filled in',
  between: 'between',
  not_between: 'outside',
  on: 'on',
  not_on: 'other than',
  before: 'before',
  after: 'after',
  on_or_before: 'on or before',
  on_or_after: 'on or after',
  relative: 'within',
  not_relative: 'outside',
  is_true: 'true',
  is_false: 'false',
};

/** A requirement in words: `Amount cannot be greater than 10000`, `License Date must be filled in`. */
export function describeRequirement(req: Requirement): string {
  const label = REQUIREMENT_WORDS[req.operator] ?? OPERATOR_LABELS[req.operator] ?? req.operator;
  const vals = req.values.map(describeOperand).filter((s) => s !== '');
  const joined = req.operator === 'between' || req.operator === 'not_between' ? vals.join(' and ') : vals.join(', ');
  return [req.field, ENFORCEMENT_LABELS[req.direction].toLowerCase(), label, joined].filter(Boolean).join(' ').trim();
}

export function payoutRuleLabel(rule: PayoutRule): string {
  return rule.name.trim() || rule.requirements.map((r) => describeRequirement(r as Requirement)).join(rule.requireAll ? ' and ' : ' or ') || 'Untitled rule';
}

export function payoutRuleMessage(rule: PayoutRule): string {
  return rule.message.trim() || rule.requirements.map((r) => describeRequirement(r as Requirement)).join(rule.requireAll ? '; ' : ' or ');
}

/**
 * Evaluate payout rules against each row. Disabled rules, rules with no
 * usable requirement, and half-built filters or requirements are ignored; a
 * rule naming a column this data doesn't have is skipped (and listed) rather
 * than treated as an error, since rules are shared across imports with
 * different layouts. The first flagging rule's reason wins.
 */
export function applyPayoutRules(rows: TypedRow[], rules: PayoutRule[], ctx: EvalContext): PayoutRulesResult {
  const errors: Record<string, string> = {};
  const skipped: string[] = [];
  const counts: Record<string, number> = {};
  const compiled: { hit: PayoutRuleHit; flags: (row: TypedRow) => boolean }[] = [];
  const asCriteria = (id: string, cond: Condition): Criteria => ({ version: 1, root: { type: 'group', id, conjunction: 'and', children: [cond] } });

  for (const r of rules) {
    if (!r.enabled) continue;
    const filters = (r.filters as Condition[]).filter((c) => c.enabled !== false && !isIncomplete(c));
    const reqs = (r.requirements as Requirement[]).filter((c) => c.enabled !== false && !isIncomplete(c));
    if (!reqs.length) continue;
    if ([...filters, ...reqs].some((c) => !(c.field in ctx.types))) {
      skipped.push(r.id);
      continue;
    }
    try {
      const applies = filters.map((c, i) => compileCriteria(asCriteria(`rule:${r.id}:f${i}`, c), ctx).matches);
      const satisfied = reqs.map((c, i) => {
        const m = compileCriteria(asCriteria(`rule:${r.id}:r${i}`, c), ctx).matches;
        return c.direction === 'cannot' ? (row: TypedRow) => !m(row) : m;
      });
      const flags = (row: TypedRow) => {
        if (!applies.every((f) => f(row))) return false;
        return r.requireAll ? satisfied.some((ok) => !ok(row)) : satisfied.every((ok) => !ok(row));
      };
      // Describe only the requirements that took part (blank or disabled rows are left out).
      const used = { ...r, requirements: reqs };
      compiled.push({ hit: { ruleId: r.id, ruleName: payoutRuleLabel(used), reasonKey: r.reasonKey, message: payoutRuleMessage(used) }, flags });
      counts[r.id] = 0;
    } catch (e) {
      errors[r.id] = (e as Error).message;
    }
  }

  const hits: (PayoutRuleHit | null)[] = [];
  const allHits: string[][] = [];
  for (const row of rows) {
    let first: PayoutRuleHit | null = null;
    const ids: string[] = [];
    for (const c of compiled) {
      if (!c.flags(row)) continue;
      counts[c.hit.ruleId]++;
      ids.push(c.hit.ruleId);
      first ??= c.hit;
    }
    hits.push(first);
    allHits.push(ids);
  }
  return { hits, allHits, counts, errors, skipped };
}
