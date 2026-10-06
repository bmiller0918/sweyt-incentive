import { describe, expect, it } from 'vitest';
import { FormulaError, compileFormula, evaluateFormula } from './formula.js';

const scope = {
  'Sum of Amount': 50000,
  Count: 4,
  Rep: 'Alice',
  Blank: null,
  plan: { rate: 0.12, quota: 40000, accel: 0.18 },
};

const ev = (src: string) => evaluateFormula(src, scope);

describe('formula', () => {
  it('arithmetic and precedence', () => {
    expect(ev('1 + 2 * 3')).toBe(7);
    expect(ev('(1 + 2) * 3')).toBe(9);
    expect(ev('2 ^ 3 ^ 2')).toBe(512);
    expect(ev('-[Count] + 10')).toBe(6);
    expect(ev('10 / 4')).toBe(2.5);
    expect(ev('10 % 4')).toBe(2);
    expect(ev('12%')).toBe(0.12);
  });

  it('references: bracketed, bare, dotted, case-insensitive', () => {
    expect(ev('[Sum of Amount] * 0.12')).toBe(6000);
    expect(ev('Count * 2')).toBe(8);
    expect(ev('count * 2')).toBe(8);
    expect(ev('[Sum of Amount] * plan.rate')).toBe(6000);
    expect(ev('plan.missing')).toBeNull();
  });

  it('comparisons, logic, IF', () => {
    expect(ev('[Sum of Amount] > plan.quota')).toBe(true);
    expect(ev('IF([Sum of Amount] > plan.quota, [Sum of Amount] * plan.accel, [Sum of Amount] * plan.rate)')).toBe(9000);
    expect(ev('Rep = "alice" AND Count >= 4')).toBe(true);
    expect(ev('Rep <> "Alice" OR NOT Count = 4')).toBe(false);
    expect(ev('IF(ISBLANK(Blank), 1, 2)')).toBe(1);
  });

  it('functions', () => {
    expect(ev('ROUND(10 / 3, 2)')).toBe(3.33);
    expect(ev('MAX(0, [Sum of Amount] - plan.quota)')).toBe(10000);
    expect(ev('MIN(1, 2, Blank)')).toBe(1);
    expect(ev('ABS(-5)')).toBe(5);
    expect(ev('FLOOR(2.7) + CEIL(2.1)')).toBe(5);
    expect(ev('COALESCE(Blank, plan.nope, 7)')).toBe(7);
  });

  it('null propagates through arithmetic', () => {
    expect(ev('Blank * 2')).toBeNull();
    expect(ev('[Sum of Amount] / 0')).toBeNull();
  });

  it('tiered example: 10% to quota, 18% above', () => {
    const tier = 'MIN([Sum of Amount], plan.quota) * plan.rate + MAX(0, [Sum of Amount] - plan.quota) * plan.accel';
    expect(ev(tier)).toBe(40000 * 0.12 + 10000 * 0.18);
  });

  it('compile-time validation', () => {
    expect(() => compileFormula('[Nope] * 2', ['Sum of Amount'])).toThrow(/Unknown field "Nope"/);
    expect(() => compileFormula('[Sum of Amount] * plan.rate', ['Sum of Amount'])).not.toThrow();
    expect(() => compileFormula('1 +', [])).toThrow(FormulaError);
    expect(() => compileFormula('FOO(1)', [])).toThrow(/Unknown function/);
    expect(() => compileFormula('(1 + 2', [])).toThrow(/Expected "\)"/);
    expect(() => compileFormula('', [])).toThrow(/empty/);
    expect(compileFormula('[A] + plan.x', ['A']).refs).toEqual(['A', 'plan.x']);
  });
});
