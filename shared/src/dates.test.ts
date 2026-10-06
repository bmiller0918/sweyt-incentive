import { describe, expect, it } from 'vitest';
import { resolveRelativeRange } from './dates.js';

// Wednesday, 2025-11-12
const NOW = Date.UTC(2025, 10, 12, 15, 0, 0);
const d = (y: number, m: number, day: number) => Date.UTC(y, m - 1, day);
const endOf = (y: number, m: number, day: number) => d(y, m, day + 1) - 1;

describe('resolveRelativeRange', () => {
  it('today / yesterday', () => {
    expect(resolveRelativeRange('today', undefined, { now: NOW })).toEqual([d(2025, 11, 12), endOf(2025, 11, 12)]);
    expect(resolveRelativeRange('yesterday', undefined, { now: NOW })).toEqual([d(2025, 11, 11), endOf(2025, 11, 11)]);
  });
  it('weeks start Monday by default', () => {
    expect(resolveRelativeRange('this_week', undefined, { now: NOW })).toEqual([d(2025, 11, 10), endOf(2025, 11, 16)]);
    expect(resolveRelativeRange('last_week', undefined, { now: NOW })).toEqual([d(2025, 11, 3), endOf(2025, 11, 9)]);
    expect(resolveRelativeRange('this_week', undefined, { now: NOW, weekStartsOn: 0 })).toEqual([
      d(2025, 11, 9),
      endOf(2025, 11, 15),
    ]);
  });
  it('months and quarters', () => {
    expect(resolveRelativeRange('this_month', undefined, { now: NOW })).toEqual([d(2025, 11, 1), endOf(2025, 11, 30)]);
    expect(resolveRelativeRange('last_month', undefined, { now: NOW })).toEqual([d(2025, 10, 1), endOf(2025, 10, 31)]);
    expect(resolveRelativeRange('this_quarter', undefined, { now: NOW })).toEqual([d(2025, 10, 1), endOf(2025, 12, 31)]);
    expect(resolveRelativeRange('last_quarter', undefined, { now: NOW })).toEqual([d(2025, 7, 1), endOf(2025, 9, 30)]);
  });
  it('year boundaries roll correctly', () => {
    const jan = Date.UTC(2026, 0, 5);
    expect(resolveRelativeRange('last_month', undefined, { now: jan })).toEqual([d(2025, 12, 1), endOf(2025, 12, 31)]);
    expect(resolveRelativeRange('last_quarter', undefined, { now: jan })).toEqual([d(2025, 10, 1), endOf(2025, 12, 31)]);
    expect(resolveRelativeRange('last_year', undefined, { now: jan })).toEqual([d(2025, 1, 1), endOf(2025, 12, 31)]);
  });
  it('fiscal periods with a February start', () => {
    const ctx = { now: NOW, fiscalYearStartMonth: 2 };
    // FY starts Feb 1 2025; Nov is in Q4 (Nov-Jan).
    expect(resolveRelativeRange('this_fiscal_quarter', undefined, ctx)).toEqual([d(2025, 11, 1), endOf(2026, 1, 31)]);
    expect(resolveRelativeRange('last_fiscal_quarter', undefined, ctx)).toEqual([d(2025, 8, 1), endOf(2025, 10, 31)]);
    expect(resolveRelativeRange('this_fiscal_year', undefined, ctx)).toEqual([d(2025, 2, 1), endOf(2026, 1, 31)]);
    expect(resolveRelativeRange('last_fiscal_year', undefined, ctx)).toEqual([d(2024, 2, 1), endOf(2025, 1, 31)]);
    // January belongs to the fiscal year that started the previous February.
    const jan = Date.UTC(2026, 0, 15);
    expect(resolveRelativeRange('this_fiscal_year', undefined, { now: jan, fiscalYearStartMonth: 2 })).toEqual([
      d(2025, 2, 1),
      endOf(2026, 1, 31),
    ]);
  });
  it('next periods', () => {
    expect(resolveRelativeRange('next_month', undefined, { now: NOW })).toEqual([d(2025, 12, 1), endOf(2025, 12, 31)]);
    expect(resolveRelativeRange('next_quarter', undefined, { now: NOW })).toEqual([d(2026, 1, 1), endOf(2026, 3, 31)]);
    expect(resolveRelativeRange('next_year', undefined, { now: NOW })).toEqual([d(2026, 1, 1), endOf(2026, 12, 31)]);
    const ctx = { now: NOW, fiscalYearStartMonth: 2 };
    expect(resolveRelativeRange('next_fiscal_quarter', undefined, ctx)).toEqual([d(2026, 2, 1), endOf(2026, 4, 30)]);
    expect(resolveRelativeRange('next_fiscal_year', undefined, ctx)).toEqual([d(2026, 2, 1), endOf(2027, 1, 31)]);
  });

  it('last/next N days', () => {
    expect(resolveRelativeRange('last_n_days', 7, { now: NOW })).toEqual([d(2025, 11, 6), endOf(2025, 11, 12)]);
    expect(resolveRelativeRange('next_n_days', 3, { now: NOW })).toEqual([d(2025, 11, 12), endOf(2025, 11, 14)]);
  });
  it('to-date presets end today', () => {
    expect(resolveRelativeRange('year_to_date', undefined, { now: NOW })).toEqual([d(2025, 1, 1), endOf(2025, 11, 12)]);
    expect(resolveRelativeRange('quarter_to_date', undefined, { now: NOW })).toEqual([d(2025, 10, 1), endOf(2025, 11, 12)]);
  });
});
