import { describe, expect, it } from 'vitest';
import { applyHoldRules, applyPayoutRules, payMonthFor, payoutRuleLabel, payoutRuleMessage, type HoldRule, type PayoutRule } from './holds.js';

describe('payMonthFor', () => {
  it('pays the month after the close by default', () => {
    expect(payMonthFor('2026-03-15')).toBe('2026-04');
    expect(payMonthFor('2026-12-31')).toBe('2027-01');
    expect(payMonthFor('2026-11-02', 2)).toBe('2027-01');
    expect(payMonthFor(null)).toBeNull();
  });
});

describe('applyHoldRules', () => {
  const ctx = { types: { 'Start Date': 'date' as const, 'Billing': 'text' as const, 'TFC': 'boolean' as const, 'Close Date': 'date' as const } };
  const rules: HoldRule[] = [
    { id: 'r1', reasonKey: 'no_upfront_billing', condition: { type: 'condition', id: 'c1', field: 'Billing', operator: 'is_not', values: [{ kind: 'literal', value: 'Upfront' }] } },
    { id: 'r2', reasonKey: 'termination_for_convenience', condition: { type: 'condition', id: 'c2', field: 'TFC', operator: 'is_true', values: [] } },
    // Not filled in yet: ignored.
    { id: 'r3', reasonKey: 'other', condition: { type: 'condition', id: 'c3', field: 'Billing', operator: 'is', values: [{ kind: 'literal', value: '' }] } },
  ];

  it('holds rows matching a rule, first rule wins', () => {
    const rows = [
      { Billing: 'Upfront', TFC: false },
      { Billing: 'Quarterly', TFC: true },
      { Billing: 'Upfront', TFC: true },
    ];
    const { reasons, errors } = applyHoldRules(rows, rules, ctx);
    expect(reasons).toEqual([null, 'no_upfront_billing', 'termination_for_convenience']);
    expect(errors).toEqual({});
  });

  it('reports a rule that cannot compile instead of skipping it silently', () => {
    const bad: HoldRule = { id: 'rx', reasonKey: 'other', condition: { type: 'condition', id: 'cx', field: 'Nope', operator: 'is', values: [{ kind: 'literal', value: 'x' }] } };
    const { reasons, errors } = applyHoldRules([{ Billing: 'Upfront', TFC: false }], [bad], ctx);
    expect(reasons).toEqual([null]);
    expect(errors.rx).toMatch(/Nope/);
  });
});

describe('applyPayoutRules', () => {
  const ctx = { types: { Billing: 'text' as const, TFC: 'boolean' as const, Amount: 'currency' as const, Customer: 'text' as const } };
  const cond = (id: string, field: string, operator: string, value?: string) =>
    ({ type: 'condition' as const, id, field, operator, values: value === undefined ? [] : [{ kind: 'literal' as const, value }] });
  const req = (id: string, field: string, direction: 'must' | 'cannot', operator: string, value?: string) => ({ ...cond(id, field, operator, value), direction });
  const rule = (id: string, partial: Partial<PayoutRule>): PayoutRule => ({ id, name: '', message: '', reasonKey: 'other', filters: [], requirements: [], requireAll: true, enabled: true, ...partial });
  const rows = [
    { Billing: 'Upfront', TFC: false, Amount: 100, Customer: 'Acme' },
    { Billing: 'Quarterly', TFC: true, Amount: 100, Customer: 'Acme' },
    { Billing: 'Upfront', TFC: true, Amount: 20000, Customer: 'Globex' },
    { Billing: null, TFC: false, Amount: 100, Customer: 'Globex' },
  ];

  it('flags deals that break a must-be or cannot-be requirement; first rule wins', () => {
    const rules = [
      rule('p1', { name: 'Upfront billing', reasonKey: 'no_upfront_billing', requirements: [req('r1', 'Billing', 'must', 'is', 'Upfront')] }),
      rule('p2', { reasonKey: 'termination_for_convenience', requirements: [req('r2', 'TFC', 'cannot', 'is_true')] }),
    ];
    const res = applyPayoutRules(rows, rules, ctx);
    expect(res.hits.map((h) => h?.reasonKey ?? null)).toEqual([null, 'no_upfront_billing', 'termination_for_convenience', 'no_upfront_billing']);
    expect(res.hits[1]?.ruleName).toBe('Upfront billing');
    expect(res.hits[1]?.message).toBe('Billing must be equal to Upfront');
    expect(res.hits[2]?.ruleName).toBe('TFC cannot be true');
    expect(res.allHits).toEqual([[], ['p1', 'p2'], ['p2'], ['p1']]);
    expect(res.counts).toEqual({ p1: 2, p2: 2 });
    expect(res.errors).toEqual({});
  });

  it('applies a rule only to deals matching its filters', () => {
    const r = rule('p', { filters: [cond('f', 'Customer', 'is', 'Globex')], requirements: [req('r', 'Amount', 'cannot', 'gt', '10000')] });
    expect(applyPayoutRules(rows, [r], ctx).allHits).toEqual([[], [], ['p'], []]);
    // Same requirement, no filter: still only the big deal breaks it.
    expect(applyPayoutRules(rows, [rule('q', { requirements: [req('r', 'Amount', 'cannot', 'gt', '10000')] })], ctx).counts).toEqual({ q: 1 });
  });

  it('require all vs require any', () => {
    const reqs = [req('a', 'Billing', 'must', 'is', 'Upfront'), req('b', 'TFC', 'must', 'is_false')];
    expect(applyPayoutRules(rows, [rule('all', { requirements: reqs, requireAll: true })], ctx).allHits).toEqual([[], ['all'], ['all'], ['all']]);
    expect(applyPayoutRules(rows, [rule('any', { requirements: reqs, requireAll: false })], ctx).allHits).toEqual([[], ['any'], [], []]);
  });

  it('ignores disabled rules and rules with no usable requirement; skips rules naming a missing column', () => {
    const rules = [
      rule('off', { enabled: false, requirements: [req('r', 'Amount', 'must', 'gt', '0')] }),
      rule('blank', { requirements: [req('r', 'Billing', 'must', 'is', '')] }),
      rule('missing', { requirements: [req('r', 'License Date', 'must', 'not_empty')] }),
      rule('missingFilter', { filters: [cond('f', 'Region', 'is', 'West')], requirements: [req('r', 'Amount', 'must', 'gt', '0')] }),
    ];
    const res = applyPayoutRules(rows, rules, ctx);
    expect(res.hits).toEqual([null, null, null, null]);
    expect(res.counts).toEqual({});
    expect(res.skipped).toEqual(['missing', 'missingFilter']);
  });

  it('describes a hit with only the requirements that took part', () => {
    const r = rule('p', { requirements: [req('blank', 'Billing', 'must', 'is', ''), req('r', 'Amount', 'cannot', 'gt', '10000')] });
    const res = applyPayoutRules(rows, [r], ctx);
    expect(res.hits[2]?.ruleName).toBe('Amount cannot be greater than 10000');
    expect(res.hits[2]?.message).toBe('Amount cannot be greater than 10000');
  });

  it('reports a rule whose value cannot be coerced to the column type', () => {
    const res = applyPayoutRules(rows, [rule('px', { requirements: [req('r', 'Amount', 'cannot', 'gt', 'lots')] })], ctx);
    expect(res.hits).toEqual([null, null, null, null]);
    expect(res.errors.px).toMatch(/lots/);
  });

  it('describes a nameless rule and its message in words', () => {
    const r = rule('a', { requirements: [req('r', 'Billing', 'must', 'is_not', 'Quarterly'), req('s', 'Amount', 'cannot', 'gt', '10000')] });
    expect(payoutRuleLabel(r)).toBe('Billing must be other than Quarterly and Amount cannot be greater than 10000');
    expect(payoutRuleLabel({ ...r, name: 'Custom' })).toBe('Custom');
    expect(payoutRuleMessage({ ...r, message: ' Fix the billing ' })).toBe('Fix the billing');
  });
});
