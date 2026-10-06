import { RELATIVE_LABELS, isCalcActive, isSummaryActive, listConditions, type Criteria } from '@commissions/shared';
import { useEffect, useState } from 'react';
import { api, type CriteriaSet } from '../api';
import { readPeriod } from '../headerFilters';

interface Props {
  onOpen: (importId: string, setId: string) => void;
}

/** One-line description of what an incentive does, for the register. */
function describe(c: Criteria): { period: string; filters: number; groupBy: string; calcs: string[] } {
  const p = readPeriod(c.root);
  const period = !p ? 'All time' : p.preset === 'custom' ? `${p.from || '…'} → ${p.to || '…'}` : `${RELATIVE_LABELS[p.preset]}${p.n ? ` (${p.n})` : ''}`;
  const filters = listConditions(c.root).filter((x) => !x.id.startsWith('period:')).length;
  const groupBy = isSummaryActive(c.summary) ? c.summary.groupBy.join(', ') || 'grand total' : '—';
  const calcs = isCalcActive(c.calc) ? c.calc.items.map((i) => i.label) : [];
  return { period, filters, groupBy, calcs };
}

export function IncentivesView({ onOpen }: Props) {
  const [sets, setSets] = useState<CriteriaSet[]>([]);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);

  const refresh = () => api.listCriteriaSets().then(setSets).catch((e) => setError(e.message));
  useEffect(() => {
    refresh();
  }, []);

  const visible = sets.filter((s) => !search || `${s.name} ${s.description ?? ''} ${s.importName ?? ''}`.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-2">
        <div>
          <div className="text-sm font-semibold">Incentives</div>
          <div className="text-xs text-slate-400">Saved filter → summarize → calculate pipelines. Open one to drill into its details.</div>
        </div>
        <div className="flex-1" />
        <input className="input w-64" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      {error && <div className="border-b border-red-200 bg-red-50 px-4 py-1.5 text-xs text-red-700">{error}</div>}
      <div className="flex-1 overflow-auto p-4">
        {visible.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-400">
            {sets.length === 0 ? (
              <>
                No saved incentives yet. Open an import, build your filter / summary / calculation, then click <strong>Save</strong>.
              </>
            ) : (
              'Nothing matches your search.'
            )}
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="text-left text-slate-400">
              <tr className="border-b border-slate-200">
                <th className="py-2 pr-3 font-normal">Incentive</th>
                <th className="py-2 pr-3 font-normal">Import</th>
                <th className="py-2 pr-3 font-normal">Period</th>
                <th className="py-2 pr-3 font-normal">Filters</th>
                <th className="py-2 pr-3 font-normal">Grouped by</th>
                <th className="py-2 pr-3 font-normal">Calculations</th>
                <th className="py-2 pr-3 font-normal">Updated</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.map((s) => {
                const d = describe(s.criteria);
                const orphan = !s.importId;
                return (
                  <tr
                    key={s.id}
                    className={`border-b border-slate-100 ${orphan ? 'text-slate-400' : 'cursor-pointer hover:bg-indigo-50'}`}
                    onClick={() => !orphan && onOpen(s.importId!, s.id)}
                  >
                    <td className="py-2 pr-3">
                      <div className="font-medium text-slate-800">{s.name}</div>
                      {s.description && <div className="text-slate-500">{s.description}</div>}
                      <div className="text-[10px] text-slate-400">v{s.version}</div>
                    </td>
                    <td className="py-2 pr-3">{s.importName ?? <span className="italic">import deleted</span>}</td>
                    <td className="py-2 pr-3 whitespace-nowrap">{d.period}</td>
                    <td className="py-2 pr-3">{d.filters || '—'}</td>
                    <td className="py-2 pr-3">{d.groupBy}</td>
                    <td className="py-2 pr-3">{d.calcs.length ? d.calcs.join(', ') : '—'}</td>
                    <td className="py-2 pr-3 whitespace-nowrap">{new Date(s.updatedAt).toLocaleString()}</td>
                    <td className="py-2 text-right">
                      <button
                        className="text-slate-400 hover:text-rose-600"
                        title="Delete incentive"
                        onClick={async (e) => {
                          e.stopPropagation();
                          if (!window.confirm(`Delete incentive "${s.name}"?`)) return;
                          await api.deleteCriteriaSet(s.id);
                          refresh();
                        }}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
