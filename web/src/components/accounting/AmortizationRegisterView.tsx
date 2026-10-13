import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type RegisterPayload, type RegisterRow } from '../../api';
import { AmortizationDetailView } from './AmortizationDetailView';
import { useSettings } from '../SettingsProvider';
import { AmortizationForm } from './AmortizationForm';
import { ErrorBar, PageHeader, STATUS_LABEL, Stat, StatusBadge, money, monthLabel } from './ui';

type SortKey = 'code' | 'name' | 'typeName' | 'payee' | 'department' | 'startMonth' | 'endMonth' | 'months' | 'amount' | 'status' | 'remaining';
const COLUMNS: { key: SortKey; label: string; right?: boolean }[] = [
  { key: 'code', label: 'ID' },
  { key: 'name', label: 'Name' },
  { key: 'typeName', label: 'Type' },
  { key: 'payee', label: 'Payee' },
  { key: 'department', label: 'Department' },
  { key: 'startMonth', label: 'Start date' },
  { key: 'endMonth', label: 'End date' },
  { key: 'months', label: 'Term (months)', right: true },
  { key: 'amount', label: 'Amount', right: true },
  { key: 'status', label: 'Status' },
  { key: 'remaining', label: 'Remaining balance', right: true },
];

export function AmortizationRegisterView({ onOpenClose, openId, onOpenId }: { onOpenClose: () => void; openId?: string | null; onOpenId?: (id: string | null) => void }) {
  const [localId, setLocalId] = useState<string | null>(null);
  const detailId = openId !== undefined ? openId : localId;
  const setDetail = onOpenId ?? setLocalId;
  const [month, setMonth] = useState<string | null>(null);
  const [data, setData] = useState<RegisterPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<'open' | 'all' | RegisterRow['status']>('open');
  const [typeFilter, setTypeFilter] = useState('');
  const [origin, setOrigin] = useState<'' | 'commission' | 'manual'>('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'code', dir: 1 });
  const [creating, setCreating] = useState(false);
  const allowManual = useSettings().settings.general.allowManualAmortizations;

  const load = useCallback(
    (m?: string | null) =>
      api
        .getRegister(m ?? undefined)
        .then((d) => {
          setData(d);
          setMonth(d.month);
        })
        .catch((e) => setError(e.message)),
    [],
  );
  useEffect(() => {
    if (!detailId) load(month);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, detailId]);

  const all = useMemo(() => (data ? [...data.pending, ...data.rows] : []), [data]);
  const rows = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    const out = all.filter(
      (r) =>
        (status === 'all' || (status === 'open' ? r.status === 'pending' || r.remaining !== 0 || r.writtenOffMonth === data.openMonth : r.status === status)) &&
        (!typeFilter || r.typeName === typeFilter) &&
        (!origin || r.origin === origin) &&
        (!q || [r.code, r.name, r.dealKey, r.payee, r.department, r.description].some((v) => v?.toLowerCase().includes(q))),
    );
    const k = sort.key;
    return out.sort((x, y) => {
      const a = k === 'code' ? x.number : x[k];
      const b = k === 'code' ? y.number : y[k];
      return (typeof a === 'number' && typeof b === 'number' ? a - b : String(a ?? '').localeCompare(String(b ?? ''))) * sort.dir;
    });
  }, [data, all, status, typeFilter, origin, search, sort]);

  if (detailId) return <AmortizationDetailView id={detailId} onBack={() => setDetail(null)} onOpenClose={onOpenClose} />;
  if (!data) return <div className="p-6 text-sm text-slate-400">{error ?? 'Loading…'}</div>;
  const rf = data.rollforward;
  const sum = (f: (r: RegisterRow) => number) => Math.round(rows.reduce((a, r) => a + f(r), 0) * 100) / 100;
  const types = [...new Set(all.map((r) => r.typeName))].sort();
  const empty = all.length === 0;

  return (
    <div className="flex h-full flex-col overflow-auto">
      <PageHeader
        section="Accounting"
        title="Amortization Register"
        hint="Every amortization: capitalized commissions booked by the monthly close, and amortizations entered by hand. Balances tie to the deferred-commission accounts in the GL."
      >
        <label className="flex items-center gap-1 text-xs text-slate-500">
          As of
          <input type="month" className="input" value={month ?? ''} onChange={(e) => e.target.value && load(e.target.value)} />
        </label>
        <button className="btn btn-sm" onClick={() => month && api.exportRegister(month)}>
          Export
        </button>
        <button className="btn btn-sm" onClick={() => api.exportSchedule()}>
          Export schedules
        </button>
        {allowManual && (
          <button className="btn btn-sm btn-primary" onClick={() => setCreating(true)}>
            New Amortization
          </button>
        )}
      </PageHeader>
      <ErrorBar error={error} onDismiss={() => setError(null)} />

      {empty ? (
        <div className="mx-auto mt-8 w-full max-w-xl rounded-lg border border-dashed border-slate-300 bg-panel p-6 text-sm">
          <div className="font-medium text-slate-700">Nothing in the register yet</div>
          <p className="mt-1 text-slate-500">
            Commissions enter the register when you close a month. You can also add an amortization by hand, such as a prepaid commission, a guaranteed draw, or an opening balance from your spreadsheet.
          </p>
          <div className="mt-3 flex gap-2">
            {allowManual && (
              <button className="btn btn-primary" onClick={() => setCreating(true)}>
                New Amortization
              </button>
            )}
            <button className="btn" onClick={onOpenClose}>
              Process monthly accounting
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-5 gap-3 p-6 pb-3">
            <Stat label={`Balance at ${monthLabel(data.month)}`} value={money(rf.closing)} sub={data.closed ? 'closed month' : 'not closed yet: projected'} />
            <Stat label="Current (next 12 months)" value={money(rf.current)} />
            <Stat label="Non-current" value={money(rf.noncurrent)} />
            <Stat label={`Amortization in ${monthLabel(data.month)}`} value={money(rf.amortization)} sub={rf.impairment ? `plus ${money(rf.impairment)} written off` : undefined} />
            <Stat
              label="Pending"
              value={money(data.pending.reduce((s, r) => s + r.amount, 0))}
              sub={`${data.pending.length} manual amortization${data.pending.length === 1 ? '' : 's'} not booked yet`}
              tone={data.pending.length ? 'warn' : undefined}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 px-6 py-2 text-xs">
            <select className="select" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
              <option value="open">Open (pending or with a balance)</option>
              <option value="all">All amortizations</option>
              {Object.entries(STATUS_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            <select className="select" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
              <option value="">All types</option>
              {types.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <select className="select" value={origin} onChange={(e) => setOrigin(e.target.value as typeof origin)}>
              <option value="">Commissions and manual</option>
              <option value="commission">From commission runs</option>
              <option value="manual">Entered by hand</option>
            </select>
            <input className="input w-64" placeholder="Search ID, name, deal, payee, department" value={search} onChange={(e) => setSearch(e.target.value)} />
            <span className="ml-auto text-slate-400">Total: {rows.length}</span>
          </div>
          <div className="px-6 pb-6">
            <table className="w-full bg-panel text-xs">
              <thead className="text-left text-slate-400">
                <tr className="border-b border-slate-200">
                  <th className="py-1.5 pr-3 font-normal">View</th>
                  {COLUMNS.map((c) => (
                    <th key={c.key} className={`py-1.5 pr-3 font-normal ${c.right ? 'text-right' : ''}`}>
                      <button className="hover:text-slate-700" onClick={() => setSort((s) => ({ key: c.key, dir: s.key === c.key ? (-s.dir as 1 | -1) : 1 }))}>
                        {c.label}
                        {sort.key === c.key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const pendingWo = r.writtenOffMonth && data.openMonth && r.writtenOffMonth >= data.openMonth;
                  return (
                    <tr key={r.id} className="cursor-pointer border-b border-slate-100 hover:bg-slate-50" onClick={() => setDetail(r.id)}>
                      <td className="py-1 pr-3 text-indigo-700">View</td>
                      <td className="py-1 pr-3 font-mono whitespace-nowrap">{r.code}</td>
                      <td className="py-1 pr-3">
                        {r.name}
                        {r.origin === 'manual' && <span className="ml-1.5 rounded bg-slate-100 px-1 text-[10px] text-slate-500">{r.opening ? 'opening' : 'manual'}</span>}
                      </td>
                      <td className="py-1 pr-3">{r.typeName}</td>
                      <td className="py-1 pr-3 whitespace-nowrap">{r.payee}</td>
                      <td className="py-1 pr-3">{r.department}</td>
                      <td className="py-1 pr-3 whitespace-nowrap">{monthLabel(r.startMonth)}</td>
                      <td className="py-1 pr-3 whitespace-nowrap">{monthLabel(r.endMonth)}</td>
                      <td className="py-1 pr-3 text-right">{r.months}</td>
                      <td className="py-1 pr-3 text-right">{money(r.amount)}</td>
                      <td className="py-1 pr-3">
                        <StatusBadge status={r.status} />
                        {pendingWo && <div className="mt-0.5 text-[10px] text-rose-700">Write-off pending</div>}
                      </td>
                      <td className="py-1 pr-3 text-right font-medium">{money(r.remaining)}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t border-slate-300 font-medium">
                  <td colSpan={9} className="py-1.5 pr-3">
                    Total
                  </td>
                  <td className="py-1.5 pr-3 text-right">{money(sum((r) => r.amount))}</td>
                  <td />
                  <td className="py-1.5 pr-3 text-right">{money(sum((r) => r.remaining))}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}
      {creating && (
        <AmortizationForm
          openMonth={data?.openMonth ?? null}
          onClose={() => setCreating(false)}
          onSaved={(id) => {
            setCreating(false);
            setDetail(id);
          }}
        />
      )}
    </div>
  );
}
