import { describe, expect, it } from 'vitest';
import { coerceRow } from './coerce.js';
import { type Condition, type Criteria, type Group, type Operand, emptyCriteria } from './criteria.js';
import { compileCriteria, conditionImpact, countMatches, filterRows, validateCriteria } from './evaluate.js';
import type { ColumnType, RawRow } from './types.js';

const types: Record<string, ColumnType> = {
  rep: 'text',
  amount: 'currency',
  quota: 'currency',
  closed: 'date',
  type: 'text',
  active: 'boolean',
};

const raw: RawRow[] = [
  { rep: 'Alice', amount: '$12,000', quota: '10000', closed: '2025-11-05', type: 'New Business', active: 'Y' },
  { rep: 'alice', amount: '(500)', quota: '10000', closed: '2025-10-20', type: 'Renewal', active: 'N' },
  { rep: 'Bob', amount: '8,000', quota: '9000', closed: '11/01/2025', type: 'New Business', active: 'Y' },
  { rep: 'Carol', amount: '', quota: '5000', closed: '', type: 'Upsell', active: '' },
  { rep: 'Dan', amount: '25000', quota: '20000', closed: '2025-08-15', type: 'New Business', active: 'true' },
];
const rows = raw.map((r) => coerceRow(r, types));
const NOW = Date.UTC(2025, 10, 12);
const ctx = { types, now: NOW };

let seq = 0;
const lit = (value: string): Operand => ({ kind: 'literal', value });
const cond = (field: string, operator: string, values: Operand[] = [], extra: Partial<Condition> = {}): Condition =>
  ({ type: 'condition', id: `c${++seq}`, field, operator, values, ...extra }) as Condition;
const group = (conjunction: 'and' | 'or', children: Group['children'], not?: boolean): Group => ({
  type: 'group',
  id: `g${++seq}`,
  conjunction,
  children,
  not,
});
const crit = (root: Group): Criteria => ({ version: 1, root });

describe('evaluate', () => {
  it('empty criteria matches everything', () => {
    expect(countMatches(rows, emptyCriteria(), ctx)).toBe(5);
  });

  it('text operators are case-insensitive by default', () => {
    expect(countMatches(rows, crit(group('and', [cond('rep', 'is', [lit('ALICE')])])), ctx)).toBe(2);
    expect(countMatches(rows, crit(group('and', [cond('rep', 'is', [lit('Alice')], { caseSensitive: true })])), ctx)).toBe(1);
    // "Renewal" contains "new" too
    expect(countMatches(rows, crit(group('and', [cond('type', 'contains', [lit('new')])])), ctx)).toBe(4);
    expect(countMatches(rows, crit(group('and', [cond('type', 'starts_with', [lit('new')])])), ctx)).toBe(3);
    expect(countMatches(rows, crit(group('and', [cond('rep', 'any_of', [lit('bob'), lit('dan')])])), ctx)).toBe(2);
    expect(countMatches(rows, crit(group('and', [cond('rep', 'regex', [lit('^[ab]')])])), ctx)).toBe(3);
  });

  it('number operators handle messy values and blanks', () => {
    expect(countMatches(rows, crit(group('and', [cond('amount', 'gt', [lit('10,000')])])), ctx)).toBe(2);
    expect(countMatches(rows, crit(group('and', [cond('amount', 'lt', [lit('0')])])), ctx)).toBe(1);
    expect(countMatches(rows, crit(group('and', [cond('amount', 'between', [lit('8000'), lit('12000')])])), ctx)).toBe(2);
    expect(countMatches(rows, crit(group('and', [cond('amount', 'empty')])), ctx)).toBe(1);
    // blank never satisfies a comparison
    expect(countMatches(rows, crit(group('and', [cond('amount', 'neq', [lit('1')])])), ctx)).toBe(4);
  });

  it('field-to-field comparison', () => {
    const c = crit(group('and', [cond('amount', 'gte', [{ kind: 'field', field: 'quota' }])]));
    expect(filterRows(rows, c, ctx).map((r) => r.rep)).toEqual(['Alice', 'Dan']);
  });

  it('date operators and relative presets', () => {
    expect(countMatches(rows, crit(group('and', [cond('closed', 'after', [lit('10/31/2025')])])), ctx)).toBe(2);
    expect(countMatches(rows, crit(group('and', [cond('closed', 'on', [lit('2025-11-01')])])), ctx)).toBe(1);
    const q = crit(group('and', [cond('closed', 'relative', [{ kind: 'relative', preset: 'this_quarter' }])]));
    expect(countMatches(rows, q, ctx)).toBe(3);
    const lastQ = crit(group('and', [cond('closed', 'relative', [{ kind: 'relative', preset: 'last_quarter' }])]));
    expect(filterRows(rows, lastQ, ctx).map((r) => r.rep)).toEqual(['Dan']);
  });

  it('booleans', () => {
    expect(countMatches(rows, crit(group('and', [cond('active', 'is_true')])), ctx)).toBe(3);
    expect(countMatches(rows, crit(group('and', [cond('active', 'empty')])), ctx)).toBe(1);
  });

  it('nested AND / OR / NOT', () => {
    const c = crit(
      group('and', [
        cond('type', 'is', [lit('New Business')]),
        group('or', [cond('rep', 'is', [lit('Bob')]), cond('amount', 'gt', [lit('20000')])]),
      ]),
    );
    expect(filterRows(rows, c, ctx).map((r) => r.rep)).toEqual(['Bob', 'Dan']);

    const notGroup = crit(group('and', [group('or', [cond('rep', 'is', [lit('Bob')]), cond('rep', 'is', [lit('Dan')])], true)]));
    expect(filterRows(rows, notGroup, ctx).map((r) => r.rep)).toEqual(['Alice', 'alice', 'Carol']);
  });

  it('parameters', () => {
    const c: Criteria = {
      version: 1,
      root: group('and', [cond('closed', 'on_or_after', [{ kind: 'param', name: 'period_start' }])]),
      params: { period_start: '2025-11-01' },
    };
    expect(countMatches(rows, c, ctx)).toBe(2);
    expect(countMatches(rows, c, { ...ctx, params: { period_start: '2025-01-01' } })).toBe(4);
  });

  it('disabled conditions are ignored', () => {
    const c = crit(group('and', [cond('rep', 'is', [lit('nobody')], { enabled: false })]));
    expect(countMatches(rows, c, ctx)).toBe(5);
  });

  it('impact and explain', () => {
    const a = cond('type', 'is', [lit('New Business')]);
    const b = cond('amount', 'gt', [lit('10000')]);
    const c = crit(group('and', [a, b]));
    const { total, impact } = conditionImpact(rows, c, ctx);
    expect(total).toBe(2);
    expect(impact[a.id]).toBe(0); // both >10k rows are already New Business
    expect(impact[b.id]).toBe(1); // removing it adds Bob

    const compiled = compileCriteria(c, ctx);
    const ex = compiled.explain(rows[2]);
    expect(ex.matched).toBe(false);
    expect(ex.conditions[a.id]).toBe(true);
    expect(ex.conditions[b.id]).toBe(false);
  });

  it('validation reports bad literals and unknown fields', () => {
    const bad = cond('amount', 'gt', [lit('abc')]);
    const unknown = cond('nope', 'is', [lit('x')]);
    const errors = validateCriteria(crit(group('and', [bad, unknown])), ctx);
    expect(errors[bad.id]).toMatch(/not a valid currency/);
    expect(errors[unknown.id]).toMatch(/Unknown field/);
  });
});
