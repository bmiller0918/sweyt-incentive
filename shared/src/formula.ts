// A small, safe expression language for calculations: no eval, no access to
// anything outside the scope you pass in.
//
//   [Sum of Amount] * plan.rate
//   IF([Sum of Amount] > plan.quota, [Sum of Amount] * 0.15, [Sum of Amount] * 0.10)
//   ROUND(MAX(0, [Won] - [Clawback]) * 0.12, 2)
//
// References: [Any Column Name] (bracketed), bare identifiers (Amount),
// dotted scope lookups (plan.rate). Operators: + - * / % ^, comparisons
// = <> != < <= > >=, AND OR NOT, parentheses. Functions: IF, MIN, MAX, ROUND,
// ABS, COALESCE, FLOOR, CEIL, ISBLANK, AND/OR as functions too.

import { planTiersSchema, tierPayout, tierRate } from './tiers.js';

export type FormulaValue = number | string | boolean | null;
/** Namespaces (e.g. plan) may hold nested objects such as a tier table. */
export type Scope = Record<string, FormulaValue | Record<string, unknown>>;

export class FormulaError extends Error {
  constructor(
    message: string,
    public pos?: number,
  ) {
    super(message);
  }
}

// -- Tokenizer ---------------------------------------------------------------

type Tok =
  | { t: 'num'; v: number; pos: number }
  | { t: 'str'; v: string; pos: number }
  | { t: 'id'; v: string; pos: number }
  | { t: 'ref'; v: string; pos: number }
  | { t: 'op'; v: string; pos: number }
  | { t: 'end'; pos: number };

const OPS = ['<=', '>=', '<>', '!=', '+', '-', '*', '/', '%', '^', '(', ')', ',', '=', '<', '>'];

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '[') {
      const end = src.indexOf(']', i);
      if (end < 0) throw new FormulaError('Unclosed [ reference', i);
      out.push({ t: 'ref', v: src.slice(i + 1, end).trim(), pos: i });
      i = end + 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== ch) s += src[j++];
      if (j >= src.length) throw new FormulaError('Unclosed string', i);
      out.push({ t: 'str', v: s, pos: i });
      i = j + 1;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?%?/i.exec(src.slice(i));
      if (!m) throw new FormulaError('Bad number', i);
      let v = Number(m[0].replace('%', ''));
      if (m[0].endsWith('%')) v /= 100;
      out.push({ t: 'num', v, pos: i });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(src.slice(i))!;
      out.push({ t: 'id', v: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new FormulaError(`Unexpected "${ch}"`, i);
    out.push({ t: 'op', v: op, pos: i });
    i += op.length;
  }
  out.push({ t: 'end', pos: src.length });
  return out;
}

// -- Parser (Pratt) ----------------------------------------------------------

export type Node =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'bool'; v: boolean }
  | { k: 'null' }
  | { k: 'ref'; name: string; pos: number }
  | { k: 'un'; op: '-' | 'not'; a: Node }
  | { k: 'bin'; op: string; a: Node; b: Node }
  | { k: 'call'; fn: string; args: Node[]; pos: number };

const PREC: Record<string, number> = {
  or: 1,
  and: 2,
  '=': 3,
  '<>': 3,
  '!=': 3,
  '<': 3,
  '<=': 3,
  '>': 3,
  '>=': 3,
  '+': 4,
  '-': 4,
  '*': 5,
  '/': 5,
  '%': 5,
  '^': 7,
};

const FUNCTIONS = new Set(['IF', 'MIN', 'MAX', 'ROUND', 'ABS', 'COALESCE', 'FLOOR', 'CEIL', 'ISBLANK', 'AND', 'OR', 'NOT', 'TIER', 'TIER_RATE']);

export function parseFormula(src: string): Node {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const expectOp = (v: string) => {
    const t = next();
    if (t.t !== 'op' || t.v !== v) throw new FormulaError(`Expected "${v}"`, t.pos);
  };

  function primary(): Node {
    const t = next();
    switch (t.t) {
      case 'num':
        return { k: 'num', v: t.v };
      case 'str':
        return { k: 'str', v: t.v };
      case 'ref':
        return { k: 'ref', name: t.v, pos: t.pos };
      case 'id': {
        const up = t.v.toUpperCase();
        if (up === 'TRUE') return { k: 'bool', v: true };
        if (up === 'FALSE') return { k: 'bool', v: false };
        if (up === 'NULL') return { k: 'null' };
        if (up === 'NOT') return { k: 'un', op: 'not', a: expr(6) };
        if (peek().t === 'op' && (peek() as { v: string }).v === '(') {
          if (!FUNCTIONS.has(up)) throw new FormulaError(`Unknown function ${t.v}`, t.pos);
          next();
          const args: Node[] = [];
          if (!(peek().t === 'op' && (peek() as { v: string }).v === ')')) {
            for (;;) {
              args.push(expr(0));
              const s = peek();
              if (s.t === 'op' && s.v === ',') {
                next();
                continue;
              }
              break;
            }
          }
          expectOp(')');
          return { k: 'call', fn: up, args, pos: t.pos };
        }
        return { k: 'ref', name: t.v, pos: t.pos };
      }
      case 'op':
        if (t.v === '(') {
          const e = expr(0);
          expectOp(')');
          return e;
        }
        if (t.v === '-') return { k: 'un', op: '-', a: expr(6) };
        if (t.v === '+') return expr(6);
        throw new FormulaError(`Unexpected "${t.v}"`, t.pos);
      case 'end':
        throw new FormulaError('Unexpected end of formula', t.pos);
    }
  }

  function expr(minPrec: number): Node {
    let left = primary();
    for (;;) {
      const t = peek();
      let op: string | null = null;
      if (t.t === 'op' && t.v in PREC) op = t.v;
      else if (t.t === 'id' && (t.v.toLowerCase() === 'and' || t.v.toLowerCase() === 'or')) op = t.v.toLowerCase();
      if (!op) break;
      const prec = PREC[op];
      if (prec < minPrec) break;
      next();
      // ^ is right-associative
      const right = expr(op === '^' ? prec : prec + 1);
      left = { k: 'bin', op, a: left, b: right };
    }
    return left;
  }

  const root = expr(0);
  if (peek().t !== 'end') throw new FormulaError('Unexpected input after expression', peek().pos);
  return root;
}

// -- Evaluation --------------------------------------------------------------

function num(v: FormulaValue): number | null {
  if (v === null || v === '') return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = Number(String(v).replace(/[$,%\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function truthy(v: FormulaValue): boolean {
  if (v === null || v === '') return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  return true;
}

function cmp(a: FormulaValue, b: FormulaValue): number | null {
  if (a === null || b === null) return null;
  const na = num(a);
  const nb = num(b);
  if (na !== null && nb !== null && (typeof a === 'number' || typeof b === 'number')) return na - nb;
  const sa = String(a).toLowerCase();
  const sb = String(b).toLowerCase();
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function isScalar(v: unknown): v is FormulaValue {
  return v === null || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean';
}

function lookup(name: string, scope: Scope): FormulaValue {
  if (name in scope) {
    const v = scope[name];
    return isScalar(v) ? v : null;
  }
  const dot = name.indexOf('.');
  if (dot > 0) {
    const ns = scope[name.slice(0, dot)];
    if (ns && typeof ns === 'object') {
      const v = (ns as Record<string, unknown>)[name.slice(dot + 1)];
      return isScalar(v) ? v : null;
    }
  }
  // Case-insensitive fallback for column names.
  const lower = name.toLowerCase();
  for (const k in scope) if (k.toLowerCase() === lower && isScalar(scope[k])) return scope[k] as FormulaValue;
  return null;
}

/** A slot's (default "plan") tier table and quota, if the scope has them. */
function planTiers(scope: Scope, slot: string) {
  const plan = scope[slot];
  if (!plan || typeof plan !== 'object') return null;
  const parsed = planTiersSchema.safeParse((plan as Record<string, unknown>).tiers);
  if (!parsed.success || !parsed.data.rows.length) return null;
  return { tiers: parsed.data, quota: num(isScalar((plan as Record<string, unknown>).quota) ? ((plan as Record<string, unknown>).quota as FormulaValue) : null) };
}

export function evaluateNode(n: Node, scope: Scope): FormulaValue {
  switch (n.k) {
    case 'num':
    case 'str':
    case 'bool':
      return n.v;
    case 'null':
      return null;
    case 'ref':
      return lookup(n.name, scope);
    case 'un': {
      const a = evaluateNode(n.a, scope);
      if (n.op === 'not') return !truthy(a);
      const x = num(a);
      return x === null ? null : -x;
    }
    case 'bin': {
      if (n.op === 'and') return truthy(evaluateNode(n.a, scope)) && truthy(evaluateNode(n.b, scope));
      if (n.op === 'or') return truthy(evaluateNode(n.a, scope)) || truthy(evaluateNode(n.b, scope));
      const a = evaluateNode(n.a, scope);
      const b = evaluateNode(n.b, scope);
      switch (n.op) {
        case '=': {
          const c = cmp(a, b);
          return c === null ? a === b : c === 0;
        }
        case '<>':
        case '!=': {
          const c = cmp(a, b);
          return c === null ? a !== b : c !== 0;
        }
        case '<':
        case '<=':
        case '>':
        case '>=': {
          const c = cmp(a, b);
          if (c === null) return null;
          return n.op === '<' ? c < 0 : n.op === '<=' ? c <= 0 : n.op === '>' ? c > 0 : c >= 0;
        }
      }
      const x = num(a);
      const y = num(b);
      if (x === null || y === null) return null;
      switch (n.op) {
        case '+':
          return x + y;
        case '-':
          return x - y;
        case '*':
          return x * y;
        case '/':
          return y === 0 ? null : x / y;
        case '%':
          return y === 0 ? null : x % y;
        case '^':
          return x ** y;
      }
      return null;
    }
    case 'call': {
      const fn = n.fn;
      const arg = (i: number) => (i < n.args.length ? evaluateNode(n.args[i], scope) : null);
      switch (fn) {
        case 'IF':
          return truthy(arg(0)) ? arg(1) : arg(2);
        case 'COALESCE':
          for (let i = 0; i < n.args.length; i++) {
            const v = arg(i);
            if (v !== null && v !== '') return v;
          }
          return null;
        case 'ISBLANK': {
          const v = arg(0);
          return v === null || v === '';
        }
        case 'AND':
          return n.args.every((_, i) => truthy(arg(i)));
        case 'OR':
          return n.args.some((_, i) => truthy(arg(i)));
        case 'NOT':
          return !truthy(arg(0));
        case 'MIN':
        case 'MAX': {
          const nums = n.args.map((_, i) => num(arg(i))).filter((v): v is number => v !== null);
          if (!nums.length) return null;
          return fn === 'MIN' ? Math.min(...nums) : Math.max(...nums);
        }
        case 'ABS': {
          const v = num(arg(0));
          return v === null ? null : Math.abs(v);
        }
        case 'FLOOR': {
          const v = num(arg(0));
          return v === null ? null : Math.floor(v);
        }
        case 'CEIL': {
          const v = num(arg(0));
          return v === null ? null : Math.ceil(v);
        }
        case 'ROUND': {
          const v = num(arg(0));
          const places = num(arg(1)) ?? 0;
          if (v === null) return null;
          const f = 10 ** places;
          return Math.round(v * f) / f;
        }
        case 'TIER':
        case 'TIER_RATE': {
          const v = num(arg(0));
          const slotArg = arg(1);
          const t = planTiers(scope, typeof slotArg === 'string' && slotArg ? slotArg : 'plan');
          if (v === null || !t) return null;
          return fn === 'TIER' ? tierPayout(v, t.tiers, t.quota) : tierRate(v, t.tiers, t.quota);
        }
      }
      return null;
    }
  }
}

/** Every reference in a formula (for validation and UI hints). */
export function formulaRefs(n: Node, out: string[] = []): string[] {
  switch (n.k) {
    case 'ref':
      out.push(n.name);
      break;
    case 'un':
      formulaRefs(n.a, out);
      break;
    case 'bin':
      formulaRefs(n.a, out);
      formulaRefs(n.b, out);
      break;
    case 'call':
      n.args.forEach((a) => formulaRefs(a, out));
      break;
  }
  return out;
}

export interface CompiledFormula {
  evaluate(scope: Scope): FormulaValue;
  refs: string[];
}

/**
 * Parse and check a formula. `knownNames` are the column names the formula
 * may reference directly. Dotted references (plan.rate, spiff.rate,
 * employee.base_salary) are namespace lookups whose contents are only known
 * at run time, so they are always accepted and yield null when missing.
 */
export function compileFormula(src: string, knownNames: string[]): CompiledFormula {
  if (!src.trim()) throw new FormulaError('Formula is empty', 0);
  const node = parseFormula(src);
  const refs = formulaRefs(node);
  const lower = new Set(knownNames.map((k) => k.toLowerCase()));
  for (const r of refs) {
    if (r.includes('.')) continue;
    if (!lower.has(r.toLowerCase())) throw new FormulaError(`Unknown field "${r}"`, 0);
  }
  return { evaluate: (scope) => evaluateNode(node, scope), refs };
}

export function evaluateFormula(src: string, scope: Scope, knownNames = Object.keys(scope)): FormulaValue {
  return compileFormula(src, knownNames).evaluate(scope);
}
