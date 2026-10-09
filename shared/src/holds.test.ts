import { describe, expect, it } from 'vitest';
import { applyHoldRules, payMonthFor, type HoldRule } from './holds.js';

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
