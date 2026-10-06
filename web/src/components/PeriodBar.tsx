import { PRESETS_NEEDING_N, RELATIVE_LABELS, familyOf, type ColumnDef, type RelativePreset } from '@commissions/shared';
import type { PeriodState } from '../headerFilters';

interface Props {
  columns: ColumnDef[];
  period: PeriodState | null;
  onChange: (p: PeriodState | null) => void;
}

/** Presets in the order they read best in a dropdown. */
const PRESET_GROUPS: { label: string; presets: RelativePreset[] }[] = [
  { label: 'Quarter', presets: ['this_quarter', 'last_quarter', 'next_quarter', 'quarter_to_date'] },
  { label: 'Fiscal', presets: ['this_fiscal_quarter', 'last_fiscal_quarter', 'next_fiscal_quarter', 'this_fiscal_year', 'last_fiscal_year', 'next_fiscal_year'] },
  { label: 'Year', presets: ['this_year', 'last_year', 'next_year', 'year_to_date'] },
  { label: 'Month', presets: ['this_month', 'last_month', 'next_month', 'month_to_date'] },
  { label: 'Week / day', presets: ['this_week', 'last_week', 'today', 'yesterday', 'last_n_days', 'next_n_days'] },
];

export function PeriodBar({ columns, period, onChange }: Props) {
  const dateCols = columns.filter((c) => familyOf(c.type) === 'date');
  if (dateCols.length === 0) return null;

  const field = period?.field ?? dateCols.find((c) => /clos|date/i.test(c.name))?.name ?? dateCols[0].name;
  const value = period ? period.preset : 'all';

  const setPreset = (v: string) => {
    if (v === 'all') return onChange(null);
    if (v === 'custom') return onChange({ field, preset: 'custom', from: period?.from ?? '', to: period?.to ?? '' });
    const preset = v as RelativePreset;
    onChange({ field, preset, n: PRESETS_NEEDING_N.has(preset) ? (period?.n ?? 30) : undefined });
  };

  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5 rounded-lg border border-indigo-200 bg-indigo-50/60 px-2 py-1.5 text-xs">
      <span className="font-semibold text-indigo-900">Period</span>
      <select className="select" value={field} onChange={(e) => onChange(period ? { ...period, field: e.target.value } : null)} title="Date column">
        {dateCols.map((c) => (
          <option key={c.name} value={c.name}>
            {c.name}
          </option>
        ))}
      </select>
      <select className="select" value={value} onChange={(e) => setPreset(e.target.value)}>
        <option value="all">All time</option>
        {PRESET_GROUPS.map((g) => (
          <optgroup key={g.label} label={g.label}>
            {g.presets.map((p) => (
              <option key={p} value={p}>
                {RELATIVE_LABELS[p]}
              </option>
            ))}
          </optgroup>
        ))}
        <option value="custom">Custom range…</option>
      </select>
      {period && period.preset !== 'custom' && PRESETS_NEEDING_N.has(period.preset) && (
        <input type="number" min={1} className="input w-20" value={period.n ?? 30} onChange={(e) => onChange({ ...period, n: Math.max(1, Number(e.target.value) || 1) })} />
      )}
      {period?.preset === 'custom' && (
        <>
          <input type="date" className="input" value={period.from ?? ''} onChange={(e) => onChange({ ...period, from: e.target.value })} />
          <span className="text-slate-400">to</span>
          <input type="date" className="input" value={period.to ?? ''} onChange={(e) => onChange({ ...period, to: e.target.value })} />
        </>
      )}
      {period && (
        <button className="ml-auto text-indigo-500 hover:text-rose-600" onClick={() => onChange(null)} title="Clear period">
          ✕
        </button>
      )}
    </div>
  );
}
