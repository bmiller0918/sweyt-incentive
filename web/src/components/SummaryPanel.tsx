import { AGG_FNS, AGG_LABELS, aggregateLabel, familyOf, type AggFn, type Aggregate, type ColumnDef, type Group, type SummarySpec } from '@commissions/shared';
import { useState } from 'react';
import { newId } from './CriteriaBuilder';

interface Props {
  spec: SummarySpec;
  columns: ColumnDef[];
  errors: Record<string, string>;
  onChange: (spec: SummarySpec) => void;
}

/** Selected chips first (numbered, draggable to reorder), then the rest. */
function DrillDownPicker({ available, selected, onChange }: { available: string[]; selected: string[]; onChange: (s: string[]) => void }) {
  const [dragging, setDragging] = useState<string | null>(null);
  const move = (from: string, to: string) => {
    if (from === to) return;
    const next = selected.filter((s) => s !== from);
    next.splice(next.indexOf(to), 0, from);
    onChange(next);
  };
  const rest = available.filter((a) => !selected.includes(a));
  return (
    <div className="flex flex-wrap gap-1">
      {selected.map((name, i) => (
        <button
          key={name}
          draggable
          onDragStart={() => setDragging(name)}
          onDragEnd={() => setDragging(null)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => dragging && move(dragging, name)}
          onClick={() => onChange(selected.filter((s) => s !== name))}
          className={`cursor-grab rounded-full border border-emerald-600 bg-emerald-600 px-2 py-0.5 text-white active:cursor-grabbing ${dragging === name ? 'opacity-40' : ''}`}
          title="Drag to reorder · click to remove"
        >
          <span className="mr-1 opacity-70">{i + 1}</span>
          {name}
        </button>
      ))}
      {rest.map((name) => (
        <button
          key={name}
          onClick={() => onChange([...selected, name])}
          className="rounded-full border border-slate-300 bg-panel px-2 py-0.5 text-slate-600 hover:bg-slate-100"
          title="Click to show in the drill-down"
        >
          {name}
        </button>
      ))}
    </div>
  );
}

/** Which source columns an aggregate function accepts. */
function fieldsFor(fn: AggFn, columns: ColumnDef[]): ColumnDef[] {
  if (fn === 'sum' || fn === 'avg') return columns.filter((c) => familyOf(c.type) === 'number');
  return columns;
}

export function SummaryPanel({ spec, columns, errors, onChange }: Props) {
  const detailFields = spec.detailFields ?? [];
  const hasHaving = !!spec.having && spec.having.children.length > 0;
  const numeric = columns.filter((c) => familyOf(c.type) === 'number');

  const setAgg = (i: number, patch: Partial<Aggregate>) =>
    onChange({ ...spec, aggregates: spec.aggregates.map((a, j) => (j === i ? { ...a, ...patch } : a)) });
  const addAgg = () => {
    const field = numeric[0]?.name;
    onChange({ ...spec, aggregates: [...spec.aggregates, { id: newId(), fn: field ? 'sum' : 'count', field }] });
  };
  const toggleGroup = (name: string) =>
    onChange({
      ...spec,
      groupBy: spec.groupBy.includes(name) ? spec.groupBy.filter((g) => g !== name) : [...spec.groupBy, name],
    });
  const setHaving = (having: Group) => onChange({ ...spec, having });

  return (
    <div className="space-y-3 text-xs">
      <div>
        <div className="mb-1 font-semibold text-slate-600">Group by</div>
        <div className="flex flex-wrap gap-1">
          {columns.map((c) => {
            const on = spec.groupBy.includes(c.name);
            const pos = spec.groupBy.indexOf(c.name);
            return (
              <button
                key={c.name}
                onClick={() => toggleGroup(c.name)}
                className={`rounded-full border px-2 py-0.5 ${
                  on ? 'border-indigo-600 bg-indigo-600 text-white' : 'border-slate-300 bg-panel text-slate-600 hover:bg-slate-100'
                }`}
                title={on ? `Grouped (${pos + 1}). Click to remove.` : 'Click to group by this column'}
              >
                {on && <span className="mr-1 opacity-70">{pos + 1}</span>}
                {c.name}
              </button>
            );
          })}
        </div>
        {spec.groupBy.length === 0 && <div className="mt-1 text-slate-400">No grouping: one grand-total row.</div>}
      </div>

      <div>
        <div className="mb-1 flex items-center">
          <span className="font-semibold text-slate-600">Aggregates</span>
          <div className="flex-1" />
          <button className="btn btn-sm" onClick={addAgg}>
            + Aggregate
          </button>
        </div>
        <div className="space-y-1">
          {spec.aggregates.map((a, i) => {
            const allowed = fieldsFor(a.fn, columns);
            return (
              <div key={a.id} className="flex flex-wrap items-center gap-1 rounded-md border border-slate-200 bg-panel px-2 py-1">
                <select
                  className="select"
                  value={a.fn}
                  onChange={(e) => {
                    const fn = e.target.value as AggFn;
                    const ok = fieldsFor(fn, columns).some((c) => c.name === a.field);
                    setAgg(i, { fn, field: fn === 'count' ? undefined : ok ? a.field : fieldsFor(fn, columns)[0]?.name });
                  }}
                >
                  {AGG_FNS.map((fn) => (
                    <option key={fn} value={fn}>
                      {AGG_LABELS[fn]}
                    </option>
                  ))}
                </select>
                {a.fn !== 'count' && (
                  <>
                    <span className="text-slate-400">of</span>
                    <select className="select max-w-[10rem]" value={a.field ?? ''} onChange={(e) => setAgg(i, { field: e.target.value })}>
                      {allowed.map((c) => (
                        <option key={c.name} value={c.name}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </>
                )}
                <span className="text-slate-400">as</span>
                <input
                  className="input w-36"
                  placeholder={aggregateLabel({ ...a, label: undefined })}
                  value={a.label ?? ''}
                  onChange={(e) => setAgg(i, { label: e.target.value || undefined })}
                />
                <div className="flex-1" />
                <button
                  className="text-slate-400 hover:text-rose-600"
                  onClick={() => onChange({ ...spec, aggregates: spec.aggregates.filter((_, j) => j !== i) })}
                  title="Remove"
                >
                  ✕
                </button>
              </div>
            );
          })}
          {spec.aggregates.length === 0 && <div className="text-slate-400">Add an aggregate, e.g. Sum of Amount.</div>}
        </div>
      </div>

      {spec.groupBy.length > 0 && (
        <div>
          <div className="mb-1 font-semibold text-slate-600">
            Drill-down columns <span className="font-normal text-slate-400">(shown when you expand a group — drag to reorder)</span>
          </div>
          <DrillDownPicker
            available={columns.filter((c) => !spec.groupBy.includes(c.name)).map((c) => c.name)}
            selected={detailFields}
            onChange={(detailFields) => onChange({ ...spec, detailFields })}
          />
          {detailFields.length === 0 && <div className="mt-1 text-slate-400">None selected: all columns are shown.</div>}
        </div>
      )}

      {/* HAVING is still supported by the engine and saved sets; the editor is
          hidden for now to keep this section simple. */}
      {hasHaving && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
          This saved set has a HAVING filter on the summary rows ({spec.having!.children.length} condition{spec.having!.children.length === 1 ? '' : 's'}).{' '}
          <button className="underline" onClick={() => setHaving({ type: 'group', id: 'having', conjunction: 'and', children: [] })}>
            Remove it
          </button>
        </div>
      )}
    </div>
  );
}
