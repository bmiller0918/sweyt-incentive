import { describe, expect, it } from 'vitest';
import {
  BUILTIN_METHODS,
  DEFAULT_SETTINGS,
  assetPosition,
  bookedTotals,
  closeMonth,
  futureAmortization,
  manualSchedule,
  rescheduleAsset,
  rollforwardRange,
  typeAccounts,
  entryBalance,
  lineSourceKey,
  registerRollforward,
  scheduleFor,
  spreadByWeights,
  suggestTypeKey,
  validateMethod,
  type AmortizationMethodDef,
  type AmortizationTypeDef,
  type CloseInput,
  type CloseLineInput,
  type NamedMethod,
  type RegisterAsset,
} from './amortization.js';

const sum = (o: Record<string, number>) => Math.round(Object.values(o).reduce((a, b) => a + b, 0) * 100) / 100;
const method = (key: string): NamedMethod => {
  const m = BUILTIN_METHODS.find((x) => x.key === key)!;
  return { id: key, name: m.name, def: m.def };
};
const methods = BUILTIN_METHODS.map((m) => method(m.key));
const ctx = { payMonth: '2026-02', contractStart: '2026-01-15', termMonths: 36, defaultTermMonths: 12 };

describe('methods', () => {
  it('straight-line over the contract term starts with the subscription', () => {
    const s = scheduleFor(36_000, method('contract_term').def, ctx);
    expect(s.capitalize).toBe(true);
    expect(s.startMonth).toBe('2026-01');
    expect(s.months).toBe(36);
    expect(s.byMonth['2026-01']).toBe(1000);
    expect(sum(s.byMonth)).toBe(36_000);
  });

  it('a term multiplier stretches the period over expected renewals', () => {
    const def: AmortizationMethodDef = { ...method('contract_term').def, termMultiplier: 1.5 };
    expect(scheduleFor(1000, def, { ...ctx, termMonths: 12 }).months).toBe(18);
  });

  it('yearly percentages spread each year evenly and sum exactly', () => {
    const s = scheduleFor(10_000, method('ramped_20_30_50').def, ctx);
    expect(s.months).toBe(36);
    expect(sum(Object.fromEntries(Object.entries(s.byMonth).filter(([m]) => m <= '2026-12')))).toBe(2000);
    expect(sum(Object.fromEntries(Object.entries(s.byMonth).filter(([m]) => m >= '2027-01' && m <= '2027-12')))).toBe(3000);
    expect(sum(s.byMonth)).toBe(10_000);
  });

  it('cumulative rounding never drifts', () => {
    const s = spreadByWeights(100, '2026-01', [1, 1, 1]);
    expect(Object.values(s)).toEqual([33.33, 33.34, 33.33]);
  });

  it('expense-immediately and the practical expedient do not capitalize', () => {
    expect(scheduleFor(500, method('immediate').def, ctx).capitalize).toBe(false);
    expect(scheduleFor(500, method('contract_term').def, { ...ctx, termMonths: 12 }, true).capitalize).toBe(false);
    expect(scheduleFor(500, method('contract_term').def, { ...ctx, termMonths: 13 }, true).capitalize).toBe(true);
    // A 48-month customer life never qualifies, even on a 12-month contract.
    expect(scheduleFor(500, method('customer_life_48').def, { ...ctx, termMonths: 12 }, true).capitalize).toBe(true);
  });

  it('validates percentages', () => {
    expect(validateMethod({ ...method('ramped_20_30_50').def, yearPercents: [20, 30] })).toEqual(['Yearly percentages add up to 50%, not 100%.']);
    expect(validateMethod(method('ramped_20_30_50').def)).toEqual([]);
  });

  it('suggests types from role names', () => {
    expect(suggestTypeKey('SDR')).toBe('sdr');
    expect(suggestTypeKey('Business Development Rep')).toBe('sdr');
    expect(suggestTypeKey('Enterprise AE')).toBe('account_executive');
    expect(suggestTypeKey('Sales Engineer')).toBe('solutions');
    expect(suggestTypeKey('Regional VP')).toBe('leadership');
    expect(suggestTypeKey('Payroll')).toBe(null);
  });
});

const asset = (over: Partial<RegisterAsset>): RegisterAsset => ({
  id: 'a1',
  sourceKey: 'k1',
  runId: null,
  lineId: 1,
  dealKey: 'D-1',
  payee: 'Alice',
  department: 'AE',
  typeName: 'Account Executives',
  methodName: 'SL',
  amount: 1200,
  capitalizedMonth: '2026-01',
  bookedMonth: '2026-01',
  startMonth: '2026-01',
  endMonth: '2026-12',
  months: 12,
  byMonth: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`2026-${String(i + 1).padStart(2, '0')}`, 100])),
  amortizationAccount: null,
  writtenOffMonth: null,
  writeOffReason: null,
  ...over,
});

describe('register positions', () => {
  it('tracks amortized, remaining and the current portion', () => {
    const p = assetPosition(asset({}), '2026-03');
    expect(p).toMatchObject({ amortizedToDate: 300, remaining: 900, amortizationThisMonth: 100, current: 900, noncurrent: 0, status: 'amortizing' });
  });

  it('catches up amortization that started before the asset was booked', () => {
    const p = assetPosition(asset({ bookedMonth: '2026-04', capitalizedMonth: '2026-04' }), '2026-04');
    expect(p.amortizationThisMonth).toBe(400);
  });

  it('writes off the remaining balance in the write-off month', () => {
    const a = asset({ writtenOffMonth: '2026-05' });
    expect(assetPosition(a, '2026-05')).toMatchObject({ amortizedToDate: 400, impairmentThisMonth: 800, remaining: 0, amortizationThisMonth: 0, status: 'written_off' });
    expect(assetPosition(a, '2026-06')).toMatchObject({ amortizationThisMonth: 0, impairmentThisMonth: 0, remaining: 0 });
  });

  it('rolls forward: opening + additions - amortization - impairment = closing', () => {
    const assets = [asset({}), asset({ id: 'a2', bookedMonth: '2026-02', capitalizedMonth: '2026-02', amount: 2400, byMonth: Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`${2026 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`, 100])) })];
    const r = registerRollforward(assets, '2026-02');
    expect(r).toMatchObject({ opening: 1100, additions: 2400, amortization: 300, impairment: 0, closing: 3200 });
    expect(r.current).toBe(1000 + 1200);
    expect(r.noncurrent).toBe(1000);
  });
});

describe('closeMonth', () => {
  const types: AmortizationTypeDef[] = [
    { id: 'ae', name: 'Account Executives', treatment: 'capitalize', methodId: null, expenseAccount: null, amortizationAccount: null },
    { id: 'sdr', name: 'SDR / BDR', treatment: 'expense', methodId: 'immediate', expenseAccount: null, amortizationAccount: null },
  ];
  const line = (over: Partial<CloseLineInput>): CloseLineInput => ({
    sourceKey: 'D-1|alice|rep||36000',
    runId: 'r1',
    lineId: 1,
    dealKey: 'D-1',
    payee: 'Alice',
    role: 'Rep',
    department: 'Enterprise AE',
    amortizationTypeId: 'ae',
    fallbackTreatment: 'capitalize',
    payout: 36_000,
    status: 'pay',
    payMonth: '2026-02',
    contractStart: '2026-02-01',
    termMonths: 36,
    ...over,
  });
  const input = (over: Partial<CloseInput>): CloseInput => ({
    month: '2026-02',
    lines: [line({}), line({ sourceKey: 'D-1|bea|bdr||5000', lineId: 2, payee: 'Bea', department: 'SDR', amortizationTypeId: 'sdr', payout: 5000 })],
    assets: [],
    booked: new Map(),
    registerStart: '2026-02',
    priorCurrent: 0,
    settings: { ...DEFAULT_SETTINGS, defaultMethodId: 'contract_term' },
    methods,
    types,
    ...over,
  });

  it('books, amortizes and reclasses a first month', () => {
    const r = closeMonth(input({}));
    expect(r.totals).toEqual({ capitalized: 36_000, expensed: 5000, amortization: 1000, impairment: 0, accrued: 41_000, manual: 0 });
    expect(r.newAssets).toHaveLength(1);
    const kinds = r.entries.map((e) => e.kind);
    expect(kinds).toEqual(['accrual', 'amortization', 'reclass']);
    for (const e of r.entries) expect(entryBalance(e).balanced).toBe(true);
    // Current = next 12 months; the true-up also covers this month's amortization credited to current.
    expect(r.reclass).toMatchObject({ target: 12_000, priorCurrent: 0, beforeReclass: -1000, netMove: 13_000 });
    expect(r.rollforward).toMatchObject({ closing: 35_000, current: 12_000, noncurrent: 23_000 });
  });

  it('second month: books nothing twice and moves one month into current', () => {
    const first = closeMonth(input({}));
    const r = closeMonth(
      input({
        month: '2026-03',
        assets: first.newAssets,
        booked: bookedTotals(first.booked),
        priorCurrent: first.reclass!.target,
      }),
    );
    expect(r.booked).toHaveLength(0);
    expect(r.totals.amortization).toBe(1000);
    expect(r.reclass).toMatchObject({ target: 12_000, priorCurrent: 12_000, beforeReclass: 11_000, netMove: 1000 });
  });

  it('reverse-and-rebook gives the same balances in two entries', () => {
    const r = closeMonth(input({ month: '2026-03', priorCurrent: 12_000, settings: { ...DEFAULT_SETTINGS, defaultMethodId: 'contract_term', reclassMode: 'reverse_rebook' }, registerStart: '2026-02' }));
    const reclass = r.entries.filter((e) => e.kind === 'reclass');
    expect(reclass).toHaveLength(2);
    // Amortization credits non-current in this mode.
    const am = r.entries.find((e) => e.kind === 'amortization')!;
    expect(am.lines.find((l) => l.credit)!.account).toBe(DEFAULT_SETTINGS.accounts.deferredNoncurrent.name);
  });

  it('books late lines, skips holds, future months and lines before the register', () => {
    const r = closeMonth(
      input({
        month: '2026-04',
        registerStart: '2026-02',
        lines: [
          line({ sourceKey: 'late', payMonth: '2026-03' }),
          line({ sourceKey: 'held', status: 'hold', payMonth: null }),
          line({ sourceKey: 'future', payMonth: '2026-05' }),
          line({ sourceKey: 'old', payMonth: '2026-01' }),
          line({ sourceKey: 'late' }),
        ],
      }),
    );
    expect(r.booked.map((b) => [b.sourceKey, b.late])).toEqual([['late', true]]);
    expect(r.excluded.map((e) => e.sourceKey)).toEqual(['old']);
    expect(r.warnings.join(' ')).toMatch(/more than one run/);
  });

  it('the practical expedient expenses short periods', () => {
    const r = closeMonth(input({ lines: [line({ termMonths: 12 })], settings: { ...DEFAULT_SETTINGS, defaultMethodId: 'contract_term', practicalExpedient: true } }));
    expect(r.booked[0]).toMatchObject({ treatment: 'expense', note: 'Practical expedient: period is 12 months or less' });
    expect(r.newAssets).toHaveLength(0);
  });

  it('write-offs produce an impairment entry', () => {
    const first = closeMonth(input({}));
    const written = first.newAssets.map((a) => ({ ...a, writtenOffMonth: '2026-03' }));
    const r = closeMonth(input({ month: '2026-03', assets: written, booked: bookedTotals(first.booked), priorCurrent: 12_000 }));
    expect(r.totals.impairment).toBe(35_000);
    expect(r.totals.amortization).toBe(0);
    expect(r.rollforward.closing).toBe(0);
    const reclass = r.entries.find((e) => e.kind === 'reclass')!;
    // Current was 12,000; impairment credited current by 35,000; reclass brings it back to 0.
    expect(reclass.lines[0]).toMatchObject({ account: DEFAULT_SETTINGS.accounts.deferredCurrent.name, debit: 23_000 });
  });

  it('source keys ignore the run and payout so reruns are not double-booked', () => {
    const k = (rowIndex: number) => lineSourceKey({ dealKey: 'D-9', rowIndex, payee: ' Maya ', role: 'Rep', tierFrom: null });
    expect(k(1)).toBe(k(7));
  });

  it('a recalculated payout books only the difference, as a new asset', () => {
    const first = closeMonth(input({}));
    const r = closeMonth(
      input({
        month: '2026-03',
        assets: first.newAssets,
        booked: bookedTotals(first.booked),
        priorCurrent: first.reclass!.target,
        lines: [line({ payout: 39_600 }), line({ sourceKey: 'D-1|bea|bdr||5000', lineId: 2, payee: 'Bea', department: 'SDR', amortizationTypeId: 'sdr', payout: 5000 })],
      }),
    );
    expect(r.booked).toHaveLength(1);
    expect(r.booked[0]).toMatchObject({ amount: 3600, adjustment: true, treatment: 'capitalize' });
    expect(r.newAssets[0].amount).toBe(3600);
    // Catch-up: Feb + Mar of the 3,600 over 36 months.
    expect(r.totals.amortization).toBe(1000 + 200);
    for (const e of r.entries) expect(entryBalance(e).balanced).toBe(true);
  });

  it('when runs disagree, the first (newest) line wins', () => {
    const r = closeMonth(input({ lines: [line({ payout: 40_000 }), line({ payout: 36_000 })] }));
    expect(r.totals.capitalized).toBe(40_000);
    expect(r.warnings.join(' ')).toMatch(/newest run/);
  });
});

describe('manual amortizations', () => {
  it('schedules straight-line from the start month, or by a method\'s curve', () => {
    const s = manualSchedule({ amount: 2000, startMonth: '2025-08', months: 12 });
    expect(s).toMatchObject({ startMonth: '2025-08', endMonth: '2026-07', months: 12 });
    expect(s.byMonth['2025-08']).toBe(166.67);
    expect(sum(s.byMonth)).toBe(2000);
    const ramp = manualSchedule({ amount: 1000, startMonth: '2026-01', months: 36, def: method('ramped_20_30_50').def });
    expect(ramp.endMonth).toBe('2028-12');
    expect(Math.round(sum(Object.fromEntries(Object.entries(ramp.byMonth).filter(([m]) => m.startsWith('2026')))))).toBe(200);
    expect(() => manualSchedule({ amount: 1000, startMonth: '2026-01', months: 12, def: method('immediate').def })).toThrow(/expenses immediately/);
  });

  it('enters the register at the close of its capitalized month, against its own offset account', () => {
    const pending = [
      asset({ id: 'm1', origin: 'manual', capitalizedMonth: '2026-02', bookedMonth: '', startMonth: '2026-02', amount: 1200, offsetAccount: { number: '2000', name: 'Accounts payable' } }),
      asset({ id: 'm2', origin: 'manual', capitalizedMonth: '2026-03', bookedMonth: '', amount: 500 }),
    ];
    const types: AmortizationTypeDef[] = [];
    const r = closeMonth({ month: '2026-02', lines: [], assets: [], booked: new Map(), registerStart: '2026-02', priorCurrent: 0, settings: DEFAULT_SETTINGS, methods, types, pending });
    expect(r.newAssets.map((a) => [a.id, a.bookedMonth])).toEqual([['m1', '2026-02']]);
    expect(r.totals.manual).toBe(1200);
    const add = r.entries.find((e) => e.kind === 'addition')!;
    expect(add.lines.find((l) => l.credit)).toMatchObject({ accountNumber: '2000', credit: 1200 });
    expect(entryBalance(add).balanced).toBe(true);
    // Feb and the Jan catch-up are both recognized now.
    expect(r.rollforward).toMatchObject({ additions: 1200, amortization: 200, closing: 1000 });
  });

  it('books no addition for an opening balance and shows it as opening in the rollforward', () => {
    const pending = [asset({ id: 'o1', origin: 'manual', opening: true, capitalizedMonth: '2026-02', bookedMonth: '', startMonth: '2026-02', amount: 1100, byMonth: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`2026-${String(i + 2).padStart(2, '0')}`, 100])) })];
    const r = closeMonth({ month: '2026-02', lines: [], assets: [], booked: new Map(), registerStart: '2026-02', priorCurrent: 0, settings: DEFAULT_SETTINGS, methods, types: [], pending });
    expect(r.entries.some((e) => e.kind === 'addition')).toBe(false);
    expect(r.rollforward).toMatchObject({ opening: 1100, additions: 0, amortization: 100, closing: 1000 });
  });
});

describe('modifications and reports', () => {
  it('re-spreads only what is left from the effective month', () => {
    // $1,200 over 2026; Jan–Mar closed ($300); extend to Jun 2027.
    const r = rescheduleAsset(asset({}), '2026-04', { endMonth: '2027-06' });
    expect(r).toMatchObject({ startMonth: '2026-01', endMonth: '2027-06', months: 18 });
    expect(r.byMonth['2026-03']).toBe(100);
    expect(r.byMonth['2026-04']).toBe(60);
    expect(sum(r.byMonth)).toBe(1200);
    expect(() => rescheduleAsset(asset({}), '2026-04', { startMonth: '2026-05', endMonth: '2026-12' })).toThrow(/start/);
    // Not started yet: the start can move.
    const later = rescheduleAsset(asset({ startMonth: '2026-06', byMonth: { '2026-06': 600, '2026-07': 600 } }), '2026-04', { startMonth: '2026-08', endMonth: '2026-09' });
    expect(later.byMonth).toEqual({ '2026-08': 600, '2026-09': 600 });
  });

  it('rolls forward over a range and shows the waterfall still to come', () => {
    const a = asset({ bookedMonth: '2025-12', capitalizedMonth: '2025-12', startMonth: '2025-12', byMonth: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`${i ? '2026' : '2025'}-${String(i ? i : 12).padStart(2, '0')}`, 100])) });
    expect(rollforwardRange(a, '2026-01', '2026-06')).toEqual({ initial: 1100, additions: 0, amortization: 600, writeOffs: 0, ending: 500 });
    expect(rollforwardRange(a, '2025-01', '2025-12')).toEqual({ initial: 0, additions: 1200, amortization: 100, writeOffs: 0, ending: 1100 });
    const w = asset({ writtenOffMonth: '2026-05' });
    expect(rollforwardRange(w, '2026-01', '2026-12')).toEqual({ initial: 0, additions: 1200, amortization: 400, writeOffs: 800, ending: 0 });
    expect(Object.keys(futureAmortization(asset({}), '2026-09'))).toEqual(['2026-10', '2026-11', '2026-12']);
    expect(futureAmortization(w, '2026-03')).toEqual({ '2026-04': 100 });
  });
});

describe('per-type accounts', () => {
  const se = { number: '1460', name: 'Deferred SE commissions, current' };
  const seNc = { number: '1760', name: 'Deferred SE commissions, non-current' };
  const types: AmortizationTypeDef[] = [
    { id: 'ae', name: 'Account Executives', treatment: 'capitalize', methodId: null, expenseAccount: null, amortizationAccount: null },
    {
      id: 'se',
      name: 'Solutions',
      treatment: 'capitalize',
      methodId: null,
      expenseAccount: null,
      amortizationAccount: { number: '6130', name: 'SE commission amortization' },
      accounts: { deferredCurrent: se, deferredNoncurrent: seNc, accruedCommissions: { number: '2160', name: 'Accrued SE commissions' } },
      defaultTermMonths: 24,
    },
  ];
  const line = (over: Partial<CloseLineInput>): CloseLineInput => ({
    sourceKey: 'D-1|alice|rep||',
    runId: 'r1',
    lineId: 1,
    dealKey: 'D-1',
    payee: 'Alice',
    role: 'Rep',
    department: 'AE',
    amortizationTypeId: 'ae',
    fallbackTreatment: 'capitalize',
    payout: 12_000,
    status: 'pay',
    payMonth: '2026-02',
    contractStart: '2026-02-01',
    termMonths: 12,
    ...over,
  });
  const lines = [line({}), line({ sourceKey: 'D-1|sam|se||', lineId: 2, payee: 'Sam', department: 'SE', amortizationTypeId: 'se', payout: 2400, termMonths: null })];
  const settings = { ...DEFAULT_SETTINGS, defaultMethodId: 'contract_term' };
  const base: CloseInput = { month: '2026-02', lines, assets: [], booked: new Map(), registerStart: '2026-02', priorCurrent: 0, settings, methods, types };

  it('merges a type\'s overrides over the company accounts', () => {
    const a = typeAccounts(types[1], DEFAULT_SETTINGS.accounts);
    expect([a.deferredCurrent.number, a.deferredNoncurrent.number, a.amortizationExpense.number, a.accruedCommissions.number, a.impairmentExpense.number]).toEqual(['1460', '1760', '6130', '2160', '6125']);
  });

  it('books each type to its own accounts, uses its default term, and reclasses each pair', () => {
    const r = closeMonth(base);
    const sam = r.newAssets.find((a) => a.payee === 'Sam')!;
    expect(sam.months).toBe(24);
    expect(sam.accounts).toEqual({ deferredCurrent: se, deferredNoncurrent: seNc });
    const accrual = r.entries.find((e) => e.kind === 'accrual')!;
    expect(accrual.lines.filter((l) => l.debit).map((l) => [l.accountNumber, l.debit])).toEqual(expect.arrayContaining([['1750', 12_000], ['1760', 2400]]));
    expect(accrual.lines.filter((l) => l.credit).map((l) => [l.accountNumber, l.credit])).toEqual(expect.arrayContaining([['2150', 12_000], ['2160', 2400]]));
    const am = r.entries.find((e) => e.kind === 'amortization')!;
    expect(am.lines.filter((l) => l.credit).map((l) => [l.accountNumber, l.credit])).toEqual(expect.arrayContaining([['1450', 1000], ['1460', 100]]));
    const rc = r.entries.filter((e) => e.kind === 'reclass');
    expect(rc).toHaveLength(2);
    expect(r.reclass!.byAccount).toEqual({ '1450|1750': 11_000, '1460|1760': 1200 });
    for (const e of r.entries) expect(entryBalance(e).balanced).toBe(true);

    // Next month starts from each pair's own current portion.
    const next = closeMonth({ ...base, month: '2026-03', assets: r.newAssets.map((a, i) => ({ ...a, id: `a${i}` })), booked: bookedTotals(r.booked), priorCurrent: r.reclass!.target, priorCurrentByAccount: r.reclass!.byAccount });
    const moves = next.entries.filter((e) => e.kind === 'reclass').map((e) => e.lines.map((l) => [l.accountNumber, l.debit, l.credit]));
    // AE: 11,000 − 1,000 = 10,000 vs target 10,000 → nothing. SE: 1,200 − 100 = 1,100 vs 1,200 → move 100.
    expect(moves).toEqual([[['1460', 100, 0], ['1760', 0, 100]]]);
  });
});

describe('formula methods', () => {
  const base: AmortizationMethodDef = { kind: 'formula', periodBasis: 'contract_term', months: null, termMultiplier: 1, yearPercents: [], monthPercents: [], startBasis: 'pay_month', formula: 'NB / RT' };
  const ctx = { payMonth: '2026-01', contractStart: null, termMonths: 12, defaultTermMonths: 12 };

  it('NB / RT is straight-line', () => {
    const s = scheduleFor(1000, base, ctx);
    expect(s.months).toBe(12);
    expect(Object.values(s.byMonth).reduce((a, b) => a + b, 0)).toBeCloseTo(1000, 2);
    expect(s.byMonth['2026-01']).toBe(83.33);
  });

  it('front-loads with double declining balance and the last month takes the rest', () => {
    const s = scheduleFor(1200, { ...base, formula: 'NB * 2 / T', periodBasis: 'fixed_months', months: 6 }, ctx);
    const v = Object.values(s.byMonth);
    expect(v[0]).toBe(400);
    expect(v[1]).toBe(266.67);
    expect(v[0]).toBeGreaterThan(v[4]);
    expect(Math.round(v.reduce((a, b) => a + b, 0) * 100) / 100).toBe(1200);
  });

  it('clamps to what is left and never goes negative', () => {
    const s = scheduleFor(100, { ...base, formula: 'IF(CP = 1, 500, -10)' }, { ...ctx, termMonths: 4 });
    expect(Object.values(s.byMonth)).toEqual([100, 0, 0, 0]);
  });

  it('uses year variables', () => {
    const s = scheduleFor(1200, { ...base, formula: 'IF(Y = 1, CV * 0.6 / 12, NB / RT)' }, { ...ctx, termMonths: 24 });
    expect(s.byMonth['2026-01']).toBe(60);
    expect(s.byMonth['2027-01']).toBe(40);
  });

  it('validates the formula', () => {
    expect(validateMethod({ ...base, formula: 'NB / XX' })[0]).toMatch(/Unknown field "XX"/);
    expect(validateMethod({ ...base, formula: '' })[0]).toMatch(/empty/);
    expect(validateMethod({ ...base, formula: 'nb / rt' })).toEqual([]);
  });
});
