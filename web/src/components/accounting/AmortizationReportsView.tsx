// Amortization reports: the roll forward (initial balance + additions −
// amortization − write-offs = ending balance) over any range, and the
// waterfall of when today's balance will be expensed. Both group by
// amortization type (or department or payee) and expand to each amortization.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, type ReportAsset, type RollforwardReport, type WaterfallReport } from '../../api';
import { ErrorBar, PageHeader, addMonths, downloadCsv, money, monthLabel } from './ui';

type GroupBy = 'typeName' | 'department' | 'payee';
const GROUP_LABEL: Record<GroupBy, string> = { typeName: 'Amortization type', department: 'Department', payee: 'Payee' };
const round = (n: number) => Math.round(n * 100) / 100;

interface Filters {
  typeName: string;
  department: string;
  origin: '' | 'commission' | 'manual';
  search: string;
}
const NO_FILTERS: Filters = { typeName: '', department: '', origin: '', search: '' };
const applyFilters = <T extends ReportAsset>(rows: T[], f: Filters) => {
  const q = f.search.trim().toLowerCase();
  return rows.filter(
    (r) =>
      (!f.typeName || r.typeName === f.typeName) &&
      (!f.department || r.department === f.department) &&
      (!f.origin || r.origin === f.origin) &&
      (!q || [r.code, r.name, r.payee].some((v) => v.toLowerCase().includes(q))),
  );
};
function groupRows<T extends ReportAsset>(rows: T[], by: GroupBy) {
  const m = new Map<string, T[]>();
  for (const r of rows) m.set(r[by], [...(m.get(r[by]) ?? []), r]);
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/** Right-hand filter panel, as in the register's reports. */
function FilterPanel({ children, rows, f, setF, groupBy, setGroupBy }: { children?: ReactNode; rows: ReportAsset[]; f: Filters; setF: (f: Filters) => void; groupBy: GroupBy; setGroupBy: (g: GroupBy) => void }) {
  const types = [...new Set(rows.map((r) => r.typeName))].sort();
  const depts = [...new Set(rows.map((r) => r.department))].sort();
  const Label = ({ children: c }: { children: ReactNode }) => <div className="mt-3 mb-1 text-[10px] font-semibold tracking-wide text-slate-400 uppercase">{c}</div>;
  return (
    <aside className="w-64 shrink-0 border-l border-slate-200 bg-slate-50 px-4 py-3 text-xs">
      {children}
      <Label>Group by</Label>
      <select className="select w-full" value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
        {(Object.keys(GROUP_LABEL) as GroupBy[]).map((g) => (
          <option key={g} value={g}>
            {GROUP_LABEL[g]}
          </option>
        ))}
      </select>
      <Label>Amortization type</Label>
      <select className="select w-full" value={f.typeName} onChange={(e) => setF({ ...f, typeName: e.target.value })}>
        <option value="">All</option>
        {types.map((t) => (
          <option key={t}>{t}</option>
        ))}
      </select>
      <Label>Department</Label>
      <select className="select w-full" value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })}>
        <option value="">All</option>
        {depts.map((t) => (
          <option key={t}>{t}</option>
        ))}
      </select>
      <Label>Source</Label>
      <select className="select w-full" value={f.origin} onChange={(e) => setF({ ...f, origin: e.target.value as Filters['origin'] })}>
        <option value="">Commissions and manual</option>
        <option value="commission">From commission runs</option>
        <option value="manual">Entered by hand</option>
      </select>
      <Label>Payee, name or ID</Label>
      <input className="input w-full" value={f.search} onChange={(e) => setF({ ...f, search: e.target.value })} />
      {(f.typeName || f.department || f.origin || f.search) && (
        <button className="mt-3 text-slate-500 underline" onClick={() => setF(NO_FILTERS)}>
          Clear filters
        </button>
      )}
    </aside>
  );
}

function useExpand() {
  const [open, setOpen] = useState<Set<string>>(new Set());
  return {
    isOpen: (k: string) => open.has(k),
    toggle: (k: string) => setOpen((s) => (s.has(k) ? new Set([...s].filter((x) => x !== k)) : new Set([...s, k]))),
    expandAll: (keys: string[]) => setOpen(new Set(keys)),
    collapseAll: () => setOpen(new Set()),
  };
}

// -- Roll forward -------------------------------------------------------------

type Preset = 'fy' | 'last_fy' | 'ytd' | 'month' | 'custom';

export function RollForwardReportView({ onOpenAsset }: { onOpenAsset: (id: string) => void }) {
  const [anchor, setAnchor] = useState<string | null>(null);
  const [preset, setPreset] = useState<Preset>('fy');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [data, setData] = useState<RollforwardReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState<Filters>(NO_FILTERS);
  const [groupBy, setGroupBy] = useState<GroupBy>('typeName');
  const ex = useExpand();

  // Anchor presets on the last closed month (or today).
  useEffect(() => {
    api
      .listPeriods()
      .then((p) => setAnchor(p.periods[p.periods.length - 1]?.month ?? new Date().toISOString().slice(0, 7)))
      .catch(() => setAnchor(new Date().toISOString().slice(0, 7)));
  }, []);
  useEffect(() => {
    if (!anchor || preset === 'custom') return;
    const y = anchor.slice(0, 4);
    const range: Record<Exclude<Preset, 'custom'>, [string, string]> = {
      fy: [`${y}-01`, `${y}-12`],
      last_fy: [`${Number(y) - 1}-01`, `${Number(y) - 1}-12`],
      ytd: [`${y}-01`, anchor],
      month: [anchor, anchor],
    };
    setFrom(range[preset][0]);
    setTo(range[preset][1]);
  }, [anchor, preset]);
  useEffect(() => {
    if (!from || !to) return;
    let stale = false;
    api
      .rollforwardReport(from, to)
      .then((d) => !stale && (setData(d), setError(null)))
      .catch((e) => !stale && setError(e.message));
    return () => {
      stale = true;
    };
  }, [from, to]);

  const rows = useMemo(() => applyFilters(data?.rows ?? [], f), [data, f]);
  const groups = useMemo(() => groupRows(rows, groupBy), [rows, groupBy]);
  type Totals = { initial: number; additions: number; amortization: number; writeOffs: number; ending: number };
  const total = (rs: Totals[]): Totals => ({
    initial: round(rs.reduce((s, r) => s + r.initial, 0)),
    additions: round(rs.reduce((s, r) => s + r.additions, 0)),
    amortization: round(rs.reduce((s, r) => s + r.amortization, 0)),
    writeOffs: round(rs.reduce((s, r) => s + r.writeOffs, 0)),
    ending: round(rs.reduce((s, r) => s + r.ending, 0)),
  });
  const grand = total(rows);
  const cells = (t: Totals) => (
    <>
      <td className="py-1.5 pr-3 text-right">{money(t.initial)}</td>
      <td className="py-1.5 pr-3 text-right">{money(t.additions)}</td>
      <td className="py-1.5 pr-3 text-right">{money(t.amortization ? -t.amortization : 0)}</td>
      <td className="py-1.5 pr-3 text-right">{money(t.writeOffs ? -t.writeOffs : 0)}</td>
      <td className="py-1.5 pr-3 text-right font-medium">{money(t.ending)}</td>
    </>
  );
  const exportCsv = () =>
    downloadCsv(
      `amortization-roll-forward-${from}-to-${to}.csv`,
      [GROUP_LABEL[groupBy], 'ID', 'Name', 'Payee', 'Department', 'Amortization Type', 'Initial Balance', 'Additions', 'Amortizations', 'Write-offs', 'Ending Balance'],
      groups.flatMap(([g, rs]) => [
        ...rs.map((r) => [g, r.code, r.name, r.payee, r.department, r.typeName, r.initial, r.additions, -r.amortization, -r.writeOffs, r.ending]),
        ...[[`${g} total`, '', '', '', '', '', ...Object.values(total(rs)).map((v, i) => (i === 2 || i === 3 ? -v : v))]],
      ]),
    );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <PageHeader section="Accounting › Amortization Register" title="Amortization Roll Forward" hint="Initial balance + additions − amortization − write-offs = ending balance, for any range of months. This is the disclosure rollforward for deferred commissions.">
        <button className="btn btn-sm" onClick={() => ex.expandAll(groups.map(([g]) => g))}>
          Expand All
        </button>
        <button className="btn btn-sm" onClick={ex.collapseAll}>
          Collapse All
        </button>
        <button className="btn btn-sm" onClick={exportCsv} disabled={!rows.length}>
          Download
        </button>
      </PageHeader>
      <ErrorBar error={error} onDismiss={() => setError(null)} />
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-auto p-6">
          {data?.projected && (
            <div className="mb-2 text-xs text-amber-700">
              {data.lastClosed ? `Months after ${monthLabel(data.lastClosed)} are not closed yet, so they are projected from the schedules.` : 'No month is closed yet, so this is projected from the schedules.'}
            </div>
          )}
          <table className="w-full bg-panel text-xs">
            <thead className="text-left text-slate-400">
              <tr className="border-b border-slate-200 bg-slate-100">
                <th className="py-2 pr-3 pl-2 font-normal">{GROUP_LABEL[groupBy]}</th>
                <th className="py-2 pr-3 text-right font-normal">Initial balance</th>
                <th className="py-2 pr-3 text-right font-normal">Additions</th>
                <th className="py-2 pr-3 text-right font-normal">Amortizations</th>
                <th className="py-2 pr-3 text-right font-normal">Write-offs</th>
                <th className="py-2 pr-3 text-right font-normal">Ending balance</th>
              </tr>
            </thead>
            <tbody>
              {groups.map(([g, rs]) => [
                <tr key={g} className="cursor-pointer border-b border-slate-200 hover:bg-slate-50" onClick={() => ex.toggle(g)}>
                  <td className="py-1.5 pr-3 pl-2 font-medium">
                    <span className="mr-2 inline-block w-3 text-slate-400">{ex.isOpen(g) ? '▾' : '▸'}</span>
                    {g} <span className="font-normal text-slate-400">({rs.length})</span>
                  </td>
                  {cells(total(rs))}
                </tr>,
                ...(ex.isOpen(g)
                  ? rs.map((r) => (
                      <tr key={r.id} className="cursor-pointer border-b border-slate-100 text-slate-600 hover:bg-slate-50" onClick={() => onOpenAsset(r.id)}>
                        <td className="py-1 pr-3 pl-7">
                          <span className="mr-2 font-mono text-[11px] text-indigo-700">{r.code}</span>
                          {r.name}
                        </td>
                        {cells(r)}
                      </tr>
                    ))
                  : []),
              ])}
              {!groups.length && (
                <tr>
                  <td colSpan={6} className="py-6 text-center text-slate-400">
                    No amortization activity in this range.
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-slate-300 font-semibold">
                <td className="py-1.5 pr-3 pl-2">Total</td>
                {cells(grand)}
              </tr>
            </tfoot>
          </table>
          {!!rows.length && Math.abs(round(grand.initial + grand.additions - grand.amortization - grand.writeOffs - grand.ending)) < 0.01 && (
            <div className="mt-1 text-right text-[11px] text-slate-400">Ties: initial + additions − amortization − write-offs = ending.</div>
          )}
        </div>
        <FilterPanel rows={data?.rows ?? []} f={f} setF={setF} groupBy={groupBy} setGroupBy={setGroupBy}>
          <div className="mb-1 text-[10px] font-semibold tracking-wide text-slate-400 uppercase">Period</div>
          <select className="select w-full" value={preset} onChange={(e) => setPreset(e.target.value as Preset)}>
            <option value="fy">FY {anchor?.slice(0, 4)}</option>
            <option value="last_fy">FY {anchor ? Number(anchor.slice(0, 4)) - 1 : ''}</option>
            <option value="ytd">Year to date</option>
            <option value="month">{anchor ? monthLabel(anchor) : 'Last closed month'}</option>
            <option value="custom">Custom</option>
          </select>
          <div className="mt-3 mb-1 text-[10px] font-semibold tracking-wide text-slate-400 uppercase">From</div>
          <input type="month" className="input w-full" value={from} onChange={(e) => e.target.value && (setPreset('custom'), setFrom(e.target.value))} />
          <div className="mt-3 mb-1 text-[10px] font-semibold tracking-wide text-slate-400 uppercase">To</div>
          <input type="month" className="input w-full" value={to} onChange={(e) => e.target.value && (setPreset('custom'), setTo(e.target.value))} />
        </FilterPanel>
      </div>
    </div>
  );
}

// -- Waterfall ------------------------------------------------------------------

type Bucket = 'month' | 'quarter' | 'year';

export function WaterfallReportView({ onOpenAsset }: { onOpenAsset: (id: string) => void }) {
  const [asOf, setAsOf] = useState<string | null>(null);
  const [data, setData] = useState<WaterfallReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bucket, setBucket] = useState<Bucket>('month');
  const [f, setF] = useState<Filters>(NO_FILTERS);
  const [groupBy, setGroupBy] = useState<GroupBy>('typeName');
  const ex = useExpand();

  useEffect(() => {
    let stale = false;
    api
      .waterfallReport(asOf ?? undefined)
      .then((d) => {
        if (stale) return;
        setData(d);
        setError(null);
        if (!asOf) setAsOf(d.asOf);
      })
      .catch((e) => !stale && setError(e.message));
    return () => {
      stale = true;
    };
  }, [asOf]);

  const rows = useMemo(() => applyFilters(data?.rows ?? [], f), [data, f]);
  const groups = useMemo(() => groupRows(rows, groupBy), [rows, groupBy]);

  // Columns: the next 12 months, 8 quarters, or every year; anything later is "Thereafter".
  const columns = useMemo(() => {
    if (!data) return [] as { key: string; label: string }[];
    const start = addMonths(data.asOf, 1);
    if (bucket === 'month') return Array.from({ length: 12 }, (_, i) => addMonths(start, i)).map((m) => ({ key: m, label: monthLabel(m) }));
    if (bucket === 'quarter') {
      const qOf = (m: string) => `${m.slice(0, 4)} Q${Math.floor((Number(m.slice(5)) - 1) / 3) + 1}`;
      const qs: string[] = [];
      for (let i = 0; qs.length < 8; i++) {
        const q = qOf(addMonths(start, i));
        if (!qs.includes(q)) qs.push(q);
      }
      return qs.map((q) => ({ key: q, label: q }));
    }
    const years = [...new Set(rows.flatMap((r) => Object.keys(r.byMonth).map((m) => m.slice(0, 4))))].sort();
    return years.map((y) => ({ key: y, label: y }));
  }, [data, bucket, rows]);
  const keyOf = (m: string) => (bucket === 'month' ? m : bucket === 'quarter' ? `${m.slice(0, 4)} Q${Math.floor((Number(m.slice(5)) - 1) / 3) + 1}` : m.slice(0, 4));
  const colKeys = new Set(columns.map((c) => c.key));
  const spread = (byMonth: Record<string, number>) => {
    const out: Record<string, number> = { thereafter: 0 };
    for (const [m, v] of Object.entries(byMonth)) {
      const k = keyOf(m);
      if (colKeys.has(k)) out[k] = (out[k] ?? 0) + v;
      else out.thereafter += v;
    }
    return out;
  };
  const sumSpreads = (rs: { byMonth: Record<string, number> }[]) => {
    const out: Record<string, number> = {};
    for (const r of rs) for (const [k, v] of Object.entries(spread(r.byMonth))) out[k] = (out[k] ?? 0) + v;
    return out;
  };
  const showThereafter = bucket !== 'year';
  const cells = (balance: number, s: Record<string, number>) => (
    <>
      <td className="py-1.5 pr-3 text-right font-medium">{money(round(balance))}</td>
      {columns.map((c) => (
        <td key={c.key} className="py-1.5 pr-3 text-right whitespace-nowrap">
          {s[c.key] ? money(round(s[c.key])) : ''}
        </td>
      ))}
      {showThereafter && <td className="py-1.5 pr-3 text-right">{s.thereafter ? money(round(s.thereafter)) : ''}</td>}
    </>
  );
  const exportCsv = () => {
    const header = [GROUP_LABEL[groupBy], 'ID', 'Name', 'Payee', 'Department', 'Amortization Type', `Balance ${data?.asOf}`, ...columns.map((c) => c.label), ...(showThereafter ? ['Thereafter'] : [])];
    const line = (s: Record<string, number>) => [...columns.map((c) => round(s[c.key] ?? 0)), ...(showThereafter ? [round(s.thereafter ?? 0)] : [])];
    downloadCsv(
      `amortization-waterfall-${data?.asOf}.csv`,
      header,
      groups.flatMap(([g, rs]) => [
        ...rs.map((r) => [g, r.code, r.name, r.payee, r.department, r.typeName, r.balance, ...line(spread(r.byMonth))]),
        [`${g} total`, '', '', '', '', '', round(rs.reduce((s, r) => s + r.balance, 0)), ...line(sumSpreads(rs))],
      ]),
    );
  };
  const grandBalance = rows.reduce((s, r) => s + r.balance, 0);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <PageHeader section="Accounting › Amortization Register" title="Amortization Waterfall" hint="When the balance at the as-of month will be expensed, by amortization type. Use it to forecast commission expense and to support the current / non-current split.">
        <button className="btn btn-sm" onClick={() => ex.expandAll(groups.map(([g]) => g))}>
          Expand All
        </button>
        <button className="btn btn-sm" onClick={ex.collapseAll}>
          Collapse All
        </button>
        <button className="btn btn-sm" onClick={exportCsv} disabled={!rows.length}>
          Download
        </button>
      </PageHeader>
      <ErrorBar error={error} onDismiss={() => setError(null)} />
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-auto p-6">
          <table className="w-full bg-panel text-xs">
            <thead className="text-left text-slate-400">
              <tr className="border-b border-slate-200 bg-slate-100">
                <th className="sticky left-0 bg-slate-100 py-2 pr-3 pl-2 font-normal">{GROUP_LABEL[groupBy]}</th>
                <th className="py-2 pr-3 text-right font-normal whitespace-nowrap">Balance {data ? monthLabel(data.asOf) : ''}</th>
                {columns.map((c) => (
                  <th key={c.key} className="py-2 pr-3 text-right font-normal whitespace-nowrap">
                    {c.label}
                  </th>
                ))}
                {showThereafter && <th className="py-2 pr-3 text-right font-normal">Thereafter</th>}
              </tr>
            </thead>
            <tbody>
              {groups.map(([g, rs]) => [
                <tr key={g} className="cursor-pointer border-b border-slate-200 hover:bg-slate-50" onClick={() => ex.toggle(g)}>
                  <td className="sticky left-0 bg-panel py-1.5 pr-3 pl-2 font-medium whitespace-nowrap">
                    <span className="mr-2 inline-block w-3 text-slate-400">{ex.isOpen(g) ? '▾' : '▸'}</span>
                    {g} <span className="font-normal text-slate-400">({rs.length})</span>
                  </td>
                  {cells(
                    rs.reduce((s, r) => s + r.balance, 0),
                    sumSpreads(rs),
                  )}
                </tr>,
                ...(ex.isOpen(g)
                  ? rs.map((r) => (
                      <tr key={r.id} className="cursor-pointer border-b border-slate-100 text-slate-600 hover:bg-slate-50" onClick={() => onOpenAsset(r.id)}>
                        <td className="sticky left-0 bg-panel py-1 pr-3 pl-7 whitespace-nowrap">
                          <span className="mr-2 font-mono text-[11px] text-indigo-700">{r.code}</span>
                          {r.name}
                        </td>
                        {cells(r.balance, spread(r.byMonth))}
                      </tr>
                    ))
                  : []),
              ])}
              {!groups.length && (
                <tr>
                  <td colSpan={columns.length + 3} className="py-6 text-center text-slate-400">
                    Nothing left to amortize at this date.
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-slate-300 font-semibold">
                <td className="sticky left-0 bg-panel py-1.5 pr-3 pl-2">Total</td>
                {cells(grandBalance, sumSpreads(rows))}
              </tr>
            </tfoot>
          </table>
        </div>
        <FilterPanel rows={data?.rows ?? []} f={f} setF={setF} groupBy={groupBy} setGroupBy={setGroupBy}>
          <div className="mb-1 text-[10px] font-semibold tracking-wide text-slate-400 uppercase">Balance as of</div>
          <input type="month" className="input w-full" value={asOf ?? ''} onChange={(e) => e.target.value && setAsOf(e.target.value)} />
          <div className="mt-3 mb-1 text-[10px] font-semibold tracking-wide text-slate-400 uppercase">Columns</div>
          <select className="select w-full" value={bucket} onChange={(e) => setBucket(e.target.value as Bucket)}>
            <option value="month">Next 12 months</option>
            <option value="quarter">Next 8 quarters</option>
            <option value="year">By year</option>
          </select>
        </FilterPanel>
      </div>
    </div>
  );
}
