import { describe, expect, it } from 'vitest';
import { coerceRow } from './coerce.js';
import { compileCriteria, type EvalContext } from './evaluate.js';
import { columnTotals, summarize, summaryColumns } from './summary.js';
import type { ColumnType, RawRow } from './types.js';

const types: Record<string, ColumnType> = { rep: 'text', stage: 'text', amount: 'currency', closed: 'date' };
const raw: RawRow[] = [
  { rep: 'Alice', stage: 'Closed Won', amount: '$1,000', closed: '2025-11-01' },
  { rep: 'Alice', stage: 'Closed Won', amount: '2,500', closed: '11/15/2025' },
  { rep: 'Alice', stage: 'Closed Lost', amount: '9,999', closed: '2025-11-20' },
  { rep: 'Bob', stage: 'Closed Won', amount: '400', closed: '2025-10-05' },
  { rep: 'Bob', stage: 'Closed Won', amount: '', closed: '' },
  { rep: 'Carol', stage: 'Open', amount: '50', closed: '' },
];
const typed = raw.map((r) => coerceRow(r, types));
const ctx: EvalContext = { types };
const all = raw.map((_, i) => i);

describe('summaryColumns', () => {
  it('names and types outputs, de-duplicating', () => {
    const cols = summaryColumns(
      {
        groupBy: ['rep'],
        aggregates: [
          { id: 'a', fn: 'sum', field: 'amount' },
          { id: 'b', fn: 'count' },
          { id: 'c', fn: 'sum', field: 'amount' },
          { id: 'd', fn: 'max', field: 'closed', label: 'Last close' },
        ],
      },
      types,
    );
    expect(cols.map((c) => c.name)).toEqual(['rep', 'Sum of amount', 'Count', 'Sum of amount (2)', 'Last close']);
    expect(cols.map((c) => c.type)).toEqual(['text', 'currency', 'integer', 'currency', 'date']);
  });
});

describe('summarize', () => {
  it('groups and aggregates, ignoring blanks', () => {
    const res = summarize(raw, typed, all, {
      groupBy: ['rep'],
      aggregates: [
        { id: 's', fn: 'sum', field: 'amount' },
        { id: 'n', fn: 'count' },
        { id: 'a', fn: 'avg', field: 'amount' },
        { id: 'mx', fn: 'max', field: 'closed' },
      ],
    }, ctx);
    expect(res.raw).toEqual([
      { rep: 'Alice', 'Sum of amount': '13499', Count: '3', 'Avg of amount': '4499.666667', 'Max of closed': '2025-11-20' },
      { rep: 'Bob', 'Sum of amount': '400', Count: '2', 'Avg of amount': '400', 'Max of closed': '2025-10-05' },
      { rep: 'Carol', 'Sum of amount': '50', Count: '1', 'Avg of amount': '50', 'Max of closed': '' },
    ]);
  });

  it('runs after a filter (closed-won only) and supports HAVING', () => {
    const filter = compileCriteria(
      { version: 1, root: { type: 'group', id: 'r', conjunction: 'and', children: [{ type: 'condition', id: 'c', field: 'stage', operator: 'is', values: [{ kind: 'literal', value: 'closed won' }] }] } },
      ctx,
    );
    const idx = all.filter((i) => filter.matches(typed[i]));
    const res = summarize(raw, typed, idx, {
      groupBy: ['rep'],
      aggregates: [{ id: 's', fn: 'sum', field: 'amount', label: 'Won' }],
      having: { type: 'group', id: 'h', conjunction: 'and', children: [{ type: 'condition', id: 'hc', field: 'Won', operator: 'gt', values: [{ kind: 'literal', value: '1000' }] }] },
    }, ctx);
    expect(res.groupCount).toBe(2);
    expect(res.raw).toEqual([{ rep: 'Alice', Won: '3500' }]);
  });

  it('grand total when there is no group by', () => {
    const res = summarize(raw, typed, all, { groupBy: [], aggregates: [{ id: 's', fn: 'sum', field: 'amount' }, { id: 'd', fn: 'count_distinct', field: 'rep' }] }, ctx);
    expect(res.raw).toEqual([{ 'Sum of amount': '13949', 'Distinct rep': '3' }]);
  });

  it('non-text keys group by typed value', () => {
    const res = summarize(raw, typed, [0, 1], { groupBy: ['closed'], aggregates: [{ id: 'n', fn: 'count' }] }, ctx);
    expect(res.raw.length).toBe(2);
    const res2 = summarize(
      [{ rep: 'x', stage: '', amount: '', closed: '2025-11-01' }, { rep: 'y', stage: '', amount: '', closed: '11/01/2025' }],
      [{ rep: 'x', stage: '', amount: null, closed: Date.UTC(2025, 10, 1) }, { rep: 'y', stage: '', amount: null, closed: Date.UTC(2025, 10, 1) }],
      [0, 1],
      { groupBy: ['closed'], aggregates: [{ id: 'n', fn: 'count' }] },
      ctx,
    );
    expect(res2.raw).toEqual([{ closed: '2025-11-01', Count: '2' }]);
  });
});

describe('columnTotals', () => {
  it('sums numeric columns over the given rows', () => {
    expect(columnTotals(typed, all, types)).toEqual({ amount: { sum: 13949, count: 5 } });
    expect(columnTotals(typed, [3, 4], types)).toEqual({ amount: { sum: 400, count: 1 } });
  });
});
