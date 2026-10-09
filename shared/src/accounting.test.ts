import { describe, expect, it } from 'vitest';
import { ACCOUNTS, addMonths, buildSubledger, straightLine, type AccountingLineInput } from './accounting.js';

const line = (over: Partial<AccountingLineInput>): AccountingLineInput => ({
  lineId: 1,
  dealKey: 'D-1',
  payee: 'Alice',
  role: 'Rep',
  department: 'Sales',
  treatment: 'capitalize',
  payout: 50_000,
  status: 'pay',
  payMonth: '2026-02',
  contractStart: '2026-01-01',
  termMonths: 36,
  ...over,
});

describe('straightLine', () => {
  it('sums exactly to the amount with the remainder in the last month', () => {
    const s = straightLine(50_000, '2026-01', 36);
    const months = Object.keys(s);
    expect(months).toHaveLength(36);
    expect(months[0]).toBe('2026-01');
    expect(months[35]).toBe('2028-12');
    expect(s['2026-01']).toBe(1388.89);
    expect(s['2028-12']).toBe(1388.85);
    expect(Math.round(Object.values(s).reduce((a, b) => a + b, 0) * 100) / 100).toBe(50_000);
  });
  it('addMonths wraps years', () => {
    expect(addMonths('2026-11', 3)).toBe('2027-02');
  });
});

describe('buildSubledger', () => {
  const policy = { method: 'contract_term' as const, customerLifeMonths: 48, defaultTermMonths: 12 };

  it("splits the month's accrual into capitalized and expensed by department", () => {
    const res = buildSubledger(
      [
        line({ lineId: 1, payout: 500_000, department: 'Sales' }),
        line({ lineId: 2, payout: 200_000, department: 'Sales Engineering', payee: 'Sam' }),
        line({ lineId: 3, payout: 100_000, department: 'BDR', treatment: 'expense', payee: 'Bea' }),
        line({ lineId: 4, payout: 999, status: 'hold', payMonth: null }),
      ],
      policy,
    );
    expect(res.accrual.map((c) => [c.department, c.capitalized, c.expensed])).toEqual([
      ['BDR', 0, 100_000],
      ['Sales', 500_000, 0],
      ['Sales Engineering', 200_000, 0],
    ]);
    expect(res.excluded).toEqual([{ lineId: 4, reason: 'On hold: not accrued until released' }]);
    const accrualJe = res.entries.find((e) => e.month === '2026-02' && e.memo.startsWith('Commissions approved'))!;
    const dr = accrualJe.lines.reduce((a, l) => a + l.debit, 0);
    const cr = accrualJe.lines.reduce((a, l) => a + l.credit, 0);
    expect(dr).toBe(800_000);
    expect(cr).toBe(800_000);
    expect(accrualJe.lines.find((l) => l.account === ACCOUNTS.expense)).toMatchObject({ department: 'BDR', debit: 100_000 });
    // BDR commissions are not capitalized, so no schedule for them.
    expect(res.schedule.map((s) => s.lineId)).toEqual([1, 2]);
  });

  it('amortizes over the contract term from the subscription start, and rolls the balance forward', () => {
    const res = buildSubledger([line({ payout: 36_000, contractStart: '2026-01-01', termMonths: 36 })], policy);
    const s = res.schedule[0];
    expect(s).toMatchObject({ startMonth: '2026-01', endMonth: '2028-12', months: 36 });
    expect(s.byMonth['2026-06']).toBe(1000);
    // Recognized in Feb (pay month) but amortizing from Jan: Jan shows amortization before the addition lands.
    expect(res.rollforward[0]).toEqual({ month: '2026-01', opening: 0, additions: 0, amortization: 1000, closing: -1000 });
    expect(res.rollforward[1]).toEqual({ month: '2026-02', opening: -1000, additions: 36_000, amortization: 1000, closing: 34_000 });
    expect(res.rollforward[res.rollforward.length - 1]).toMatchObject({ month: '2028-12', closing: 0 });
    const amort = res.entries.filter((e) => e.memo.startsWith('Amortization'));
    expect(amort).toHaveLength(36);
    expect(amort[0].lines).toEqual([
      { account: ACCOUNTS.amortization, department: 'Sales', debit: 1000, credit: 0 },
      { account: ACCOUNTS.deferred, department: null, debit: 0, credit: 1000 },
    ]);
  });

  it('under the practical expedient, amortizes from the pay month over the customer life regardless of term', () => {
    const res = buildSubledger([line({ payout: 48_000, termMonths: 12 })], { method: 'customer_life', customerLifeMonths: 48, defaultTermMonths: 12 });
    expect(res.schedule[0]).toMatchObject({ startMonth: '2026-02', endMonth: '2030-01', months: 48 });
    expect(res.schedule[0].byMonth['2026-02']).toBe(1000);
    expect(res.warnings).toEqual([]);
  });

  it('falls back to the default term and warns when the data has none', () => {
    const res = buildSubledger([line({ termMonths: null, contractStart: null })], policy);
    expect(res.schedule[0]).toMatchObject({ startMonth: '2026-02', months: 12 });
    expect(res.warnings).toHaveLength(2);
  });
});
