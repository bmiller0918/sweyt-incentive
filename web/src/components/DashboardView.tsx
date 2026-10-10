import { useEffect, useState } from 'react';
import { api, type CommissionRun, type CriteriaSet, type Employee, type ImportSummary } from '../api';

interface Props {
  onOpenRuns: () => void;
  onOpenImport: (id: string) => void;
  onOpenIncentive: (importId: string, setId: string) => void;
}

const money = (n: number) => n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

/** Overview: what's loaded, the latest runs, and where the money is. */
export function DashboardView({ onOpenRuns, onOpenImport, onOpenIncentive }: Props) {
  const [imports, setImports] = useState<ImportSummary[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [incentives, setIncentives] = useState<CriteriaSet[]>([]);
  const [runs, setRuns] = useState<CommissionRun[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.listImports(), api.listEmployees(), api.listCriteriaSets(), api.listCommissionRuns()])
      .then(([i, e, c, r]) => {
        setImports(i);
        setEmployees(e);
        setIncentives(c);
        setRuns(r);
      })
      .catch((e) => setError(e.message));
  }, []);

  const active = employees.filter((e) => e.status === 'active').length;
  const noPlan = employees.filter((e) => e.status === 'active' && e.assignments.length === 0 && !(e.inherited?.length)).length;
  const latest = runs[0];
  const payoutTotal = runs.reduce((s, r) => s + (r.totalPayout ?? 0), 0);

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div>
        <h1 className="text-lg font-semibold">Overview</h1>
        <p className="text-xs text-slate-500">A glance at what's loaded and what's been paid out.</p>
      </div>
      {error && <div className="rounded bg-rose-50 px-2 py-1 text-xs text-rose-700">{error}</div>}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Employees" value={String(employees.length)} sub={`${active} active${noPlan ? ` · ${noPlan} without a plan` : ''}`} warn={noPlan > 0} />
        <Tile label="Imports" value={String(imports.length)} sub={`${imports.reduce((s, i) => s + i.rowCount, 0).toLocaleString()} rows`} />
        <Tile label="Incentives" value={String(incentives.length)} sub="saved pipelines" />
        <Tile label="Commission runs" value={String(runs.length)} sub={runs.length ? `${money(payoutTotal)} across all runs` : 'none yet'} />
      </div>

      <section className="space-y-2">
        <div className="flex items-center">
          <h2 className="text-sm font-semibold">Latest commission runs</h2>
          <div className="flex-1" />
          <button className="btn btn-sm" onClick={onOpenRuns}>
            All runs
          </button>
        </div>
        {runs.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 bg-panel p-6 text-center text-sm text-slate-400">No runs yet — go to Commissions to calculate one.</div>
        ) : (
          <table className="w-full text-xs">
            <thead className="text-left text-slate-400">
              <tr className="border-b border-slate-200">
                <th className="py-2 pr-3 font-normal">Run</th>
                <th className="py-2 pr-3 font-normal">Import</th>
                <th className="py-2 pr-3 text-right font-normal">Deals</th>
                <th className="py-2 pr-3 text-right font-normal">Lines</th>
                <th className="py-2 pr-3 text-right font-normal">Payout</th>
                <th className="py-2 pr-3 font-normal">Warnings</th>
                <th className="py-2 font-normal">Created</th>
              </tr>
            </thead>
            <tbody>
              {runs.slice(0, 8).map((r) => (
                <tr key={r.id} className="cursor-pointer border-b border-slate-100 hover:bg-indigo-50" onClick={onOpenRuns}>
                  <td className="py-2 pr-3 font-medium">{r.name}</td>
                  <td className="py-2 pr-3 text-slate-500">{r.importName}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{r.dealCount.toLocaleString()}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{r.lineCount.toLocaleString()}</td>
                  <td className="py-2 pr-3 text-right tabular-nums font-medium">{money(r.totalPayout ?? 0)}</td>
                  <td className="py-2 pr-3">{r.warnings?.length ? <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800">{r.warnings.length}</span> : <span className="text-slate-400">—</span>}</td>
                  <td className="py-2 text-slate-500">{new Date(r.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {latest && latest.warnings?.length > 0 && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
            <div className="mb-1 font-semibold">Latest run warnings</div>
            <ul className="list-disc space-y-0.5 pl-4">
              {latest.warnings.slice(0, 5).map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <div className="grid gap-6 md:grid-cols-2">
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Recent imports</h2>
          <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-panel text-sm">
            {imports.slice(0, 6).map((i) => (
              <li key={i.id} className="flex cursor-pointer items-center gap-2 px-3 py-2 hover:bg-indigo-50" onClick={() => onOpenImport(i.id)}>
                <span className="flex-1 truncate">{i.name}</span>
                <span className="text-xs text-slate-400">{i.rowCount.toLocaleString()} rows</span>
              </li>
            ))}
            {imports.length === 0 && <li className="px-3 py-3 text-xs text-slate-400">Nothing imported yet.</li>}
          </ul>
        </section>
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Saved incentives</h2>
          <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-panel text-sm">
            {incentives.slice(0, 6).map((s) => (
              <li
                key={s.id}
                className={`flex items-center gap-2 px-3 py-2 ${s.importId ? 'cursor-pointer hover:bg-indigo-50' : 'text-slate-400'}`}
                onClick={() => s.importId && onOpenIncentive(s.importId, s.id)}
              >
                <span className="flex-1 truncate">{s.name}</span>
                <span className="text-xs text-slate-400">{s.importName ?? 'import deleted'}</span>
              </li>
            ))}
            {incentives.length === 0 && <li className="px-3 py-3 text-xs text-slate-400">No saved incentives yet.</li>}
          </ul>
        </section>
      </div>
    </div>
  );
}

function Tile({ label, value, sub, warn }: { label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-panel p-4">
      <div className="text-[11px] uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {sub && <div className={`mt-0.5 text-xs ${warn ? 'text-amber-700' : 'text-slate-500'}`}>{sub}</div>}
    </div>
  );
}
