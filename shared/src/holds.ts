// Pay-now / on-hold: a deal is paid on the next payroll unless it trips a
// hold rule (start delayed, can't bill upfront, termination for convenience,
// ...). Held lines wait, with a reason, until someone releases them; a
// released line then pays like a deal that closed on the release date.
import { conditionSchema, type Condition, type Criteria } from './criteria.js';
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
