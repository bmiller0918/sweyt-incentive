import {
  OPERATORS_BY_FAMILY,
  OPERATOR_LABELS,
  familyOf,
  operandArity,
  type ColumnDef,
  type Condition,
  type Criteria,
  type Operand,
  type Operator,
} from '@commissions/shared';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../api';
import { opId, type HeaderFilterState, withoutHeaderFilter } from '../headerFilters';
import { OperandInput } from './CriteriaBuilder';

interface Props {
  importId: string;
  column: ColumnDef;
  columns: ColumnDef[];
  criteria: Criteria;
  params: Record<string, string>;
  state: HeaderFilterState;
  anchor: DOMRect;
  onChange: (state: HeaderFilterState) => void;
  onClose: () => void;
}

const WIDTH = 320;

function defaultValues(op: Operator): Operand[] {
  const a = operandArity(op);
  if (a === 0) return [];
  if (a === 2) return [{ kind: 'literal', value: '' }, { kind: 'literal', value: '' }];
  if (op === 'relative' || op === 'not_relative') return [{ kind: 'relative', preset: 'this_quarter' }];
  return [{ kind: 'literal', value: '' }];
}

export function HeaderFilterPopover({ importId, column, columns, criteria, params, state, anchor, onChange, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState('');
  const [values, setValues] = useState<{ value: string; count: number }[]>([]);
  const [meta, setMeta] = useState<{ distinct: number; truncated: boolean }>({ distinct: 0, truncated: false });
  const [loading, setLoading] = useState(true);
  const [pos, setPos] = useState({ left: anchor.left, top: anchor.bottom + 4 });

  // Keep the popover on screen.
  useLayoutEffect(() => {
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - WIDTH - 8));
    setPos({ left, top: anchor.bottom + 4 });
  }, [anchor]);

  // Close on outside click / Escape.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // Distinct values under the *other* filters (Excel-style counts).
  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    const t = setTimeout(() => {
      api
        .values(importId, { field: column.name, criteria: { ...criteria, root: withoutHeaderFilter(criteria.root, column.name) }, params, search }, ctrl.signal)
        .then((r) => {
          setValues(r.values);
          setMeta({ distinct: r.distinct, truncated: r.truncated });
          setLoading(false);
        })
        .catch((e) => {
          if ((e as Error).name !== 'AbortError') setLoading(false);
        });
    }, search ? 200 : 0);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [importId, column.name, criteria, params, search]);

  const selected = state.selected ? new Set(state.selected) : null;
  const isChecked = (v: string) => (selected ? selected.has(v) : true);
  const toggle = (v: string) => {
    let next: Set<string>;
    if (selected) {
      next = new Set(selected);
      if (next.has(v)) next.delete(v);
      else next.add(v);
    } else {
      // Unticking one value from "all" means every other visible value.
      next = new Set(values.map((x) => x.value));
      next.delete(v);
    }
    onChange({ ...state, selected: next.size === 0 ? [] : [...next] });
  };
  const only = (v: string) => onChange({ ...state, selected: [v] });

  const family = familyOf(column.type);
  const operators = OPERATORS_BY_FAMILY[family].filter((o) => o !== 'any_of' && o !== 'none_of');
  const op = state.op;
  const setOp = (operator: Operator | '') => {
    if (!operator) return onChange({ ...state, op: null });
    const cond: Condition = {
      type: 'condition',
      id: opId(column.name),
      field: column.name,
      operator,
      values: op && operandArity(op.operator) === operandArity(operator) ? op.values : defaultValues(operator),
    };
    onChange({ ...state, op: cond });
  };
  const setOpValue = (i: number, v: Operand) => {
    if (!op) return;
    const vals = [...op.values];
    vals[i] = v;
    onChange({ ...state, op: { ...op, values: vals } });
  };
  const arity = op ? operandArity(op.operator) : 0;
  const isRelative = op?.operator === 'relative' || op?.operator === 'not_relative';

  return (
    <div
      ref={ref}
      className="fixed z-30 flex max-h-[70vh] flex-col rounded-lg border border-slate-200 bg-panel text-xs shadow-xl"
      style={{ left: pos.left, top: pos.top, width: WIDTH }}
    >
      <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-2">
        <span className="truncate font-semibold">{column.name}</span>
        <span className="text-[10px] uppercase tracking-wide text-slate-400">{column.type}</span>
        <div className="flex-1" />
        <button
          className="text-slate-500 hover:text-rose-600 disabled:opacity-40"
          disabled={!state.selected && !state.op}
          onClick={() => onChange({ selected: null, op: null })}
        >
          Clear
        </button>
        <button className="text-slate-400 hover:text-slate-700" onClick={onClose} title="Close">
          ✕
        </button>
      </div>

      {/* Operator row */}
      <div className="flex flex-wrap items-center gap-1 border-b border-slate-100 px-3 py-2">
        <select className="select" value={op?.operator ?? ''} onChange={(e) => setOp(e.target.value as Operator | '')}>
          <option value="">— condition —</option>
          {operators.map((o) => (
            <option key={o} value={o}>
              {OPERATOR_LABELS[o]}
            </option>
          ))}
        </select>
        {op && arity === 1 && <OperandInput value={op.values[0] ?? { kind: 'literal', value: '' }} onChange={(v) => setOpValue(0, v)} columns={columns} col={column} isRelative={isRelative} />}
        {op && arity === 2 && (
          <>
            <OperandInput value={op.values[0] ?? { kind: 'literal', value: '' }} onChange={(v) => setOpValue(0, v)} columns={columns} col={column} />
            <span className="text-slate-400">and</span>
            <OperandInput value={op.values[1] ?? { kind: 'literal', value: '' }} onChange={(v) => setOpValue(1, v)} columns={columns} col={column} />
          </>
        )}
      </div>

      {/* Value list */}
      <div className="flex items-center gap-2 px-3 py-2">
        <input className="input flex-1" placeholder="Search values…" value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />
        <button className="text-indigo-600 hover:underline" onClick={() => onChange({ ...state, selected: null })}>
          All
        </button>
        <button className="text-slate-500 hover:underline" onClick={() => onChange({ ...state, selected: [] })}>
          None
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-1 pb-1">
        {loading && values.length === 0 && <div className="px-2 py-3 text-slate-400">Loading…</div>}
        {!loading && values.length === 0 && <div className="px-2 py-3 text-slate-400">No values.</div>}
        {values.map((v) => (
          <label key={v.value} className="group flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-slate-50">
            <input type="checkbox" checked={isChecked(v.value)} onChange={() => toggle(v.value)} />
            <span className={`flex-1 truncate ${v.value === '' ? 'italic text-slate-400' : ''}`} title={v.value}>
              {v.value === '' ? '(blank)' : v.value}
            </span>
            <button
              className="hidden text-[10px] text-indigo-600 group-hover:inline"
              onClick={(e) => {
                e.preventDefault();
                only(v.value);
              }}
            >
              only
            </button>
            <span className="tabular-nums text-slate-400">{v.count.toLocaleString()}</span>
          </label>
        ))}
      </div>
      <div className="border-t border-slate-100 px-3 py-1.5 text-[11px] text-slate-400">
        {meta.distinct.toLocaleString()} distinct{meta.truncated ? ` · showing top ${values.length}; search to find others` : ''}
        {state.selected && ` · ${state.selected.length} selected`}
      </div>
    </div>
  );
}
