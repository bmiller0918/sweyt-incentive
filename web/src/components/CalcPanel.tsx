import { FormulaError, PLAN_COLUMN, compileFormula, familyOf, type CalcSpec, type ColumnDef } from '@commissions/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type CompPlan } from '../api';
import { newId } from './CriteriaBuilder';

interface Props {
  spec: CalcSpec;
  /** The summary's output columns (group-bys + aggregates). */
  summaryColumns: ColumnDef[];
  /** Server-side per-item errors (merged with local validation). */
  errors: Record<string, string>;
  noPlan?: number;
  onChange: (spec: CalcSpec) => void;
}

const FUNCTION_HINTS = ['IF(cond, a, b)', 'MIN(a, b)', 'MAX(a, b)', 'ROUND(x, 2)', 'ABS(x)', 'COALESCE(a, b)', 'ISBLANK(x)'];

export function CalcPanel({ spec, summaryColumns, errors, noPlan, onChange }: Props) {
  const [plans, setPlans] = useState<CompPlan[]>([]);
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});

  useEffect(() => {
    api.listPlans().then(setPlans).catch(() => {});
  }, []);

  const paramKeys = useMemo(() => [...new Set(plans.flatMap((p) => Object.keys(p.params)))].sort(), [plans]);
  const textGroupCols = summaryColumns.filter((c) => familyOf(c.type) === 'text');

  // Names a formula may reference: summary columns, Plan, and earlier calc labels.
  const knownFor = (index: number) => [
    ...summaryColumns.map((c) => c.name),
    ...(spec.repField ? [PLAN_COLUMN] : []),
    ...spec.items.slice(0, index).map((i) => i.label.trim()).filter(Boolean),
  ];
  const localError = (index: number): string | null => {
    const item = spec.items[index];
    if (!item.formula.trim()) return null;
    try {
      compileFormula(item.formula, knownFor(index));
      return null;
    } catch (e) {
      return e instanceof FormulaError ? e.message : String(e);
    }
  };

  const setItem = (i: number, patch: Partial<CalcSpec['items'][number]>) =>
    onChange({ ...spec, items: spec.items.map((it, j) => (j === i ? { ...it, ...patch } : it)) });
  const insert = (i: number, text: string) => {
    const el = inputs.current[spec.items[i].id];
    const item = spec.items[i];
    if (!el) return setItem(i, { formula: item.formula + text });
    const start = el.selectionStart ?? item.formula.length;
    const end = el.selectionEnd ?? start;
    const next = item.formula.slice(0, start) + text + item.formula.slice(end);
    setItem(i, { formula: next });
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + text.length, start + text.length);
    });
  };

  const [active, setActive] = useState(0);

  return (
    <div className="space-y-3 text-xs">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-slate-600">
          Rep column <span className="text-slate-400">(for comp-plan lookup)</span>
          <select className="select mt-1 block" value={spec.repField ?? ''} onChange={(e) => onChange({ ...spec, repField: e.target.value || undefined })}>
            <option value="">— none (no plan lookup) —</option>
            {textGroupCols.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        {spec.repField && (
          <label className="text-slate-600">
            As of
            <input type="date" className="input mt-1 block" value={spec.asOf ?? ''} onChange={(e) => onChange({ ...spec, asOf: e.target.value || undefined })} />
          </label>
        )}
        {spec.repField && plans.length === 0 && <span className="text-amber-700">No comp plans exist yet — create one under Comp plans.</span>}
        {spec.repField && noPlan !== undefined && noPlan > 0 && (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800">
            {noPlan} row{noPlan === 1 ? '' : 's'} with no plan (blank results)
          </span>
        )}
      </div>

      <div>
        <div className="mb-1 flex items-center">
          <span className="font-semibold text-slate-600">Calculations</span>
          <div className="flex-1" />
          <button
            className="btn btn-sm"
            onClick={() => {
              const amount = summaryColumns.find((c) => familyOf(c.type) === 'number');
              const formula = amount ? `[${amount.name}] * ${spec.repField ? 'plan.rate' : '12%'}` : '';
              onChange({ ...spec, items: [...spec.items, { id: newId(), label: `Calc ${spec.items.length + 1}`, formula }] });
              setActive(spec.items.length);
            }}
          >
            + Calculation
          </button>
        </div>
        <div className="space-y-1">
          {spec.items.map((item, i) => {
            const err = localError(i) ?? errors[item.id];
            return (
              <div key={item.id} className={`rounded-md border px-2 py-1.5 ${err ? 'border-rose-300 bg-rose-50' : 'border-slate-200 bg-white'}`}>
                <div className="flex items-center gap-1">
                  <input className="input w-36" value={item.label} placeholder="Column name" onChange={(e) => setItem(i, { label: e.target.value })} />
                  <span className="text-slate-400">=</span>
                  <input
                    ref={(el) => {
                      inputs.current[item.id] = el;
                    }}
                    className="input flex-1 font-mono"
                    value={item.formula}
                    placeholder="[Sum of Amount] * plan.rate"
                    onFocus={() => setActive(i)}
                    onChange={(e) => setItem(i, { formula: e.target.value })}
                  />
                  <button className="text-slate-400 hover:text-rose-600" onClick={() => onChange({ ...spec, items: spec.items.filter((_, j) => j !== i) })} title="Remove">
                    ✕
                  </button>
                </div>
                {err && <div className="mt-1 text-[11px] text-rose-700">{err}</div>}
              </div>
            );
          })}
          {spec.items.length === 0 && <div className="text-slate-400">Add a calculation, e.g. Commission = [Sum of Amount] * plan.rate</div>}
        </div>
      </div>

      {spec.items.length > 0 && (
        <div className="space-y-1 rounded-md bg-slate-50 p-2">
          <div className="text-[11px] text-slate-500">Click to insert into the focused formula:</div>
          <div className="flex flex-wrap gap-1">
            {knownFor(Math.min(active, spec.items.length - 1)).map((n) => (
              <button key={n} className="rounded-full border border-slate-300 bg-white px-2 py-0.5 hover:bg-indigo-50" onClick={() => insert(Math.min(active, spec.items.length - 1), `[${n}]`)}>
                [{n}]
              </button>
            ))}
            {spec.repField &&
              paramKeys.map((k) => (
                <button key={k} className="rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 font-mono text-emerald-800 hover:bg-emerald-100" onClick={() => insert(Math.min(active, spec.items.length - 1), `plan.${k}`)}>
                  plan.{k}
                </button>
              ))}
            {FUNCTION_HINTS.map((f) => (
              <button key={f} className="rounded-full border border-slate-300 bg-white px-2 py-0.5 font-mono text-slate-600 hover:bg-indigo-50" onClick={() => insert(Math.min(active, spec.items.length - 1), f.replace(/\(.*\)/, '('))}>
                {f}
              </button>
            ))}
          </div>
          <div className="text-[11px] text-slate-400">
            Operators: + − × ÷ ^, comparisons, AND / OR / NOT. Percentages work: <code>12%</code>. Later rows can reference earlier results by name.
          </div>
        </div>
      )}
    </div>
  );
}
