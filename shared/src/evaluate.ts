// Evaluates a criteria AST against typed rows. The same code runs for live
// preview counts, per-condition impact, row explanations, and export.
import { coerceValue } from './coerce.js';
import type { Condition, Criteria, CriteriaNode, Group, Operand, Operator } from './criteria.js';
import { listConditions, withoutCondition } from './criteria.js';
import { endOfDayUtc, resolveRelativeRange, startOfDayUtc, type DateContext } from './dates.js';
import { familyOf, type ColumnType, type TypedRow, type TypedValue } from './types.js';

export interface EvalContext extends DateContext {
  /** Column name -> type, for coercing literal operands and picking comparisons. */
  types: Record<string, ColumnType>;
  /** Runtime parameter values, merged over criteria.params. */
  params?: Record<string, string>;
}

/** A compiled condition: operands resolved to closures, regexes precompiled. */
interface CompiledCondition {
  id: string;
  enabled: boolean;
  field: string;
  operator: Operator;
  type: ColumnType;
  caseSensitive: boolean;
  /** Resolves operand i against the current row. */
  operands: Array<(row: TypedRow) => TypedValue | [number, number]>;
  regex?: RegExp;
  /** Pre-lowercased literal set for any_of/none_of on text. */
  textSet?: Set<string>;
}

type CompiledNode =
  | { kind: 'cond'; c: CompiledCondition }
  | { kind: 'group'; conjunction: 'and' | 'or'; not: boolean; children: CompiledNode[] };

export class CriteriaError extends Error {
  constructor(
    message: string,
    public conditionId?: string,
  ) {
    super(message);
  }
}

function compileOperand(op: Operand, type: ColumnType, ctx: EvalContext, cond: Condition) {
  switch (op.kind) {
    case 'literal': {
      const v = coerceValue(op.value, type);
      if (v === null && op.value.trim() !== '') {
        throw new CriteriaError(`"${op.value}" is not a valid ${type} for ${cond.field}`, cond.id);
      }
      return () => v;
    }
    case 'param': {
      const raw = ctx.params?.[op.name];
      if (raw === undefined) throw new CriteriaError(`Missing parameter {{${op.name}}}`, cond.id);
      const v = coerceValue(raw, type);
      return () => v;
    }
    case 'field': {
      const f = op.field;
      if (!(f in ctx.types)) throw new CriteriaError(`Unknown field "${f}"`, cond.id);
      return (row: TypedRow) => row[f] ?? null;
    }
    case 'relative': {
      const r = resolveRelativeRange(op.preset, op.n, ctx);
      return () => r;
    }
  }
}

function compileCondition(cond: Condition, ctx: EvalContext): CompiledCondition {
  const type = ctx.types[cond.field];
  if (!type) throw new CriteriaError(`Unknown field "${cond.field}"`, cond.id);
  const caseSensitive = cond.caseSensitive ?? false;
  const compiled: CompiledCondition = {
    id: cond.id,
    enabled: cond.enabled !== false,
    field: cond.field,
    operator: cond.operator,
    type,
    caseSensitive,
    operands: cond.values.map((v) => compileOperand(v, type, ctx, cond)),
  };
  if (cond.operator === 'regex') {
    const src = cond.values[0];
    if (!src || src.kind !== 'literal') throw new CriteriaError('Regex needs a pattern', cond.id);
    try {
      compiled.regex = new RegExp(src.value, caseSensitive ? '' : 'i');
    } catch (e) {
      throw new CriteriaError(`Invalid regex: ${(e as Error).message}`, cond.id);
    }
  }
  if ((cond.operator === 'any_of' || cond.operator === 'none_of') && familyOf(type) === 'text') {
    compiled.textSet = new Set(
      cond.values
        .filter((v): v is Extract<Operand, { kind: 'literal' }> => v.kind === 'literal')
        .map((v) => (caseSensitive ? v.value : v.value.toLowerCase())),
    );
  }
  return compiled;
}

function compileNode(node: CriteriaNode, ctx: EvalContext): CompiledNode {
  if (node.type === 'condition') return { kind: 'cond', c: compileCondition(node, ctx) };
  return {
    kind: 'group',
    conjunction: node.conjunction,
    not: node.not ?? false,
    children: node.children.map((c) => compileNode(c, ctx)),
  };
}

// -- Per-condition evaluation -----------------------------------------------

function scalar(v: TypedValue | [number, number]): TypedValue {
  return Array.isArray(v) ? v[0] : v;
}

function evalCondition(c: CompiledCondition, row: TypedRow): boolean {
  const left = row[c.field] ?? null;
  const op = c.operator;

  // Operators that don't need a right-hand side.
  if (op === 'empty') return left === null || left === '';
  if (op === 'not_empty') return !(left === null || left === '');
  if (op === 'is_true') return left === true;
  if (op === 'is_false') return left === false;

  const family = familyOf(c.type);

  if (family === 'text') {
    const l = left === null ? '' : String(left);
    const norm = (s: string) => (c.caseSensitive ? s : s.toLowerCase());
    const rhs = () => {
      const r = scalar(c.operands[0]?.(row) ?? null);
      return r === null ? '' : String(r);
    };
    switch (op) {
      case 'is':
        return norm(l) === norm(rhs());
      case 'is_not':
        return norm(l) !== norm(rhs());
      case 'contains':
        return norm(l).includes(norm(rhs()));
      case 'not_contains':
        return !norm(l).includes(norm(rhs()));
      case 'starts_with':
        return norm(l).startsWith(norm(rhs()));
      case 'ends_with':
        return norm(l).endsWith(norm(rhs()));
      case 'regex':
        return c.regex!.test(l);
      case 'any_of':
        return c.textSet!.has(norm(l));
      case 'none_of':
        return !c.textSet!.has(norm(l));
      default:
        return false;
    }
  }

  if (family === 'number') {
    if (typeof left !== 'number') return false;
    const r0 = () => scalar(c.operands[0]?.(row) ?? null);
    const r1 = () => scalar(c.operands[1]?.(row) ?? null);
    switch (op) {
      case 'eq':
        return left === r0();
      case 'neq':
        return left !== r0();
      case 'gt':
        return typeof r0() === 'number' && left > (r0() as number);
      case 'gte':
        return typeof r0() === 'number' && left >= (r0() as number);
      case 'lt':
        return typeof r0() === 'number' && left < (r0() as number);
      case 'lte':
        return typeof r0() === 'number' && left <= (r0() as number);
      case 'between':
      case 'not_between': {
        const a = r0();
        const b = r1();
        if (typeof a !== 'number' || typeof b !== 'number') return false;
        const inRange = left >= Math.min(a, b) && left <= Math.max(a, b);
        return op === 'between' ? inRange : !inRange;
      }
      case 'any_of':
      case 'none_of': {
        const hit = c.operands.some((f) => scalar(f(row)) === left);
        return op === 'any_of' ? hit : !hit;
      }
      default:
        return false;
    }
  }

  if (family === 'date') {
    if (typeof left !== 'number') return false;
    // Date-only columns compare on whole days; datetime compares exact ms.
    const dayOnly = c.type === 'date';
    const l = dayOnly ? startOfDayUtc(left) : left;
    const r0 = () => scalar(c.operands[0]?.(row) ?? null);
    const r1 = () => scalar(c.operands[1]?.(row) ?? null);
    const rhsDay = (v: TypedValue) => (typeof v === 'number' ? startOfDayUtc(v) : null);
    switch (op) {
      case 'on': {
        const r = rhsDay(r0());
        return r !== null && startOfDayUtc(left) === r;
      }
      case 'not_on': {
        const r = rhsDay(r0());
        return r !== null && startOfDayUtc(left) !== r;
      }
      case 'before': {
        const r = r0();
        return typeof r === 'number' && l < (dayOnly ? startOfDayUtc(r) : r);
      }
      case 'after': {
        const r = r0();
        return typeof r === 'number' && l > (dayOnly ? endOfDayUtc(r) : r);
      }
      case 'on_or_before': {
        const r = r0();
        return typeof r === 'number' && l <= (dayOnly ? endOfDayUtc(r) : r);
      }
      case 'on_or_after': {
        const r = r0();
        return typeof r === 'number' && l >= (dayOnly ? startOfDayUtc(r) : r);
      }
      case 'between':
      case 'not_between': {
        const a = r0();
        const b = r1();
        if (typeof a !== 'number' || typeof b !== 'number') return false;
        const lo = startOfDayUtc(Math.min(a, b));
        const hi = endOfDayUtc(Math.max(a, b));
        const inRange = left >= lo && left <= hi;
        return op === 'between' ? inRange : !inRange;
      }
      case 'relative':
      case 'not_relative': {
        const r = c.operands[0]?.(row);
        if (!Array.isArray(r)) return false;
        const inRange = left >= r[0] && left <= r[1];
        return op === 'relative' ? inRange : !inRange;
      }
      default:
        return false;
    }
  }

  // boolean family: only the zero-arity ops apply, handled above.
  return false;
}

function evalNode(node: CompiledNode, row: TypedRow, trace?: Map<string, boolean>): boolean {
  if (node.kind === 'cond') {
    if (!node.c.enabled) return true;
    const r = evalCondition(node.c, row);
    trace?.set(node.c.id, r);
    return r;
  }
  // Empty group matches everything (so a fresh builder shows all rows).
  let result: boolean;
  if (node.children.length === 0) result = true;
  else if (node.conjunction === 'and') {
    result = true;
    for (const ch of node.children) {
      // When tracing, evaluate everything so the explanation is complete.
      if (!evalNode(ch, row, trace)) {
        result = false;
        if (!trace) break;
      }
    }
  } else {
    result = false;
    for (const ch of node.children) {
      if (evalNode(ch, row, trace)) {
        result = true;
        if (!trace) break;
      }
    }
  }
  return node.not ? !result : result;
}

// -- Public API --------------------------------------------------------------

export interface CompiledCriteria {
  matches(row: TypedRow): boolean;
  /** Evaluate and report each condition's result for one row. */
  explain(row: TypedRow): { matched: boolean; conditions: Record<string, boolean> };
}

export function compileCriteria(criteria: Criteria, ctx: EvalContext): CompiledCriteria {
  const merged: EvalContext = { ...ctx, params: { ...(criteria.params ?? {}), ...(ctx.params ?? {}) } };
  const root = compileNode(criteria.root, merged);
  return {
    matches: (row) => evalNode(root, row),
    explain: (row) => {
      const trace = new Map<string, boolean>();
      const matched = evalNode(root, row, trace);
      return { matched, conditions: Object.fromEntries(trace) };
    },
  };
}

export function filterRows<T extends TypedRow>(rows: T[], criteria: Criteria, ctx: EvalContext): T[] {
  const c = compileCriteria(criteria, ctx);
  return rows.filter((r) => c.matches(r));
}

export function countMatches(rows: TypedRow[], criteria: Criteria, ctx: EvalContext): number {
  const c = compileCriteria(criteria, ctx);
  let n = 0;
  for (const r of rows) if (c.matches(r)) n++;
  return n;
}

/**
 * For each condition, how many rows it removes relative to the same criteria
 * with that condition deleted. Zero means the condition is redundant.
 */
export function conditionImpact(
  rows: TypedRow[],
  criteria: Criteria,
  ctx: EvalContext,
): { total: number; impact: Record<string, number> } {
  const total = countMatches(rows, criteria, ctx);
  const impact: Record<string, number> = {};
  for (const cond of listConditions(criteria.root)) {
    if (cond.enabled === false) {
      impact[cond.id] = 0;
      continue;
    }
    const without: Group = withoutCondition(criteria.root, cond.id);
    const n = countMatches(rows, { ...criteria, root: without }, ctx);
    impact[cond.id] = n - total;
  }
  return { total, impact };
}

/** Validate structure and compile-ability; returns per-condition errors. */
export function validateCriteria(criteria: Criteria, ctx: EvalContext): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const cond of listConditions(criteria.root)) {
    try {
      compileCondition(cond, ctx);
    } catch (e) {
      if (e instanceof CriteriaError) errors[cond.id] = e.message;
      else errors[cond.id] = String(e);
    }
  }
  return errors;
}
