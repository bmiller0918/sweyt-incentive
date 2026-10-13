import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type RegisterPayload, type RegisterRow } from '../../api';
import { Bars, ErrorBar, PageHeader, Stat, money, monthLabel } from './ui';

const STATUS_LABEL: Record<RegisterRow['status'], string> = {
  not_started: 'Not started',
  amortizing: 'Amortizing',
  fully_amortized: 'Fully amortized',
  written_off: 'Written off',
};
const STATUS_TONE: Record<RegisterRow['status'], string> = {
  not_started: 'bg-sky-100 text-sky-800',
  amortizing: 'bg-emerald-100 text-emerald-700',
  fully_amortized: 'bg-slate-100 text-slate-500',
  written_off: 'bg-rose-100 text-rose-700',
};

export function AmortizationRegisterView({ onOpenClose }: { onOpenClose: () => void }) {
  const [month, setMonth] = useState<string | null>(null);
  const [data, setData] = useState<RegisterPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<'open' | 'all' | RegisterRow['status']>('open');
  const [typeFilter, setTypeFilter] = useState('');
  const [search, setSearch] = useState('');

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
    load();
  }, [load]);

  const rows = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    return data.rows.filter(
      (r) =>
        (status === 'all' || (status === 'open' ? r.remaining !== 0 || r.writtenOffMonth === data.openMonth : r.status === status)) &&
        (!typeFilter || r.typeName === typeFilter) &&
        (!q || [r.dealKey, r.payee, r.department].some((v) => v?.toLowerCase().includes(q))),
    );
  }, [data, status, typeFilter, search]);

  const writeOff = async (r: RegisterRow) => {
    const reason = window.prompt(`Write off the remaining ${money(r.remaining)} on ${r.dealKey ?? 'this deal'} (${r.payee}) in the next open month? Reason:`, 'Customer churned');
    if (!reason) return;
    try {
      await api.writeOffAsset(r.id, reason);
      await load(month);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const undo = async (r: RegisterRow) => {
    try {
      await api.undoWriteOff(r.id);
      await load(month);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!data) return <div className="p-6 text-sm text-slate-400">{error ?? 'Loading…'}</div>;
  const rf = data.rollforward;
  const sum = (f: (r: RegisterRow) => number) => Math.round(rows.reduce((a, r) => a + f(r), 0) * 100) / 100;
  const types = [...new Set(data.rows.map((r) => r.typeName))].sort();
  const empty = data.rows.length === 0;

  return (
    <div className="flex h-full flex-col overflow-auto">
      <PageHeader
        section="Accounting"
        title="Amortization Register"
        hint="The subledger of capitalized commissions: one row per commission, booked when its month is closed. Balances tie to the deferred-commission accounts in the GL."
      >
        <label className="flex items-center gap-1 text-xs text-slate-500">
          As of
          <input type="month" className="input" value={month ?? ''} onChange={(e) => e.target.value && load(e.target.value)} />
        </label>
        <button className="btn btn-sm" onClick={() => month && api.exportRegister(month)}>
          Export register
        </button>
        <button className="btn btn-sm" onClick={() => api.exportSchedule()}>
          Export full schedule
        </button>
      </PageHeader>
      <ErrorBar error={error} onDismiss={() => setError(null)} />

      {empty ? (
        <div className="mx-auto mt-8 w-full max-w-xl rounded-lg border border-dashed border-slate-300 bg-panel p-6 text-sm">
          <div className="font-medium text-slate-700">Nothing in the register yet</div>
          <p className="mt-1 text-slate-500">Commissions enter the register when you close a month. Map your roles under Amortization Types, then close your first month.</p>
          <button className="btn btn-primary mt-3" onClick={onOpenClose}>
            Process monthly accounting
          </button>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-5 gap-3 p-6 pb-3">
            <Stat label={`Balance at ${monthLabel(data.month)}`} value={money(rf.closing)} sub={data.closed ? 'closed month' : 'not closed yet: projected'} />
            <Stat label="Current (next 12 months)" value={money(rf.current)} />
            <Stat label="Non-current" value={money(rf.noncurrent)} />
            <Stat label={`Amortization in ${monthLabel(data.month)}`} value={money(rf.amortization)} sub={rf.impairment ? `plus ${money(rf.impairment)} written off` : undefined} />
            <Stat label={`Added in ${monthLabel(data.month)}`} value={money(rf.additions)} sub={`${data.rows.filter((r) => r.bookedMonth === data.month).length} commissions`} />
          </div>

          <div className="grid grid-cols-3 gap-4 px-6 pb-4">
            <div className="col-span-2">
              <div className="mb-1 text-xs font-semibold text-slate-500">Rollforward by month (disclosure: opening + capitalized − amortized − impaired = closing)</div>
              <table className="w-full bg-panel text-xs">
                <thead className="text-left text-slate-400">
                  <tr className="border-b border-slate-200">
                    <th className="py-1.5 pr-3 font-normal">Month</th>
                    <th className="py-1.5 pr-3 text-right font-normal">Opening</th>
                    <th className="py-1.5 pr-3 text-right font-normal">Capitalized</th>
                    <th className="py-1.5 pr-3 text-right font-normal">Amortized</th>
                    <th className="py-1.5 pr-3 text-right font-normal">Written off</th>
                    <th className="py-1.5 pr-3 text-right font-normal">Closing</th>
                    <th className="py-1.5 pr-3 text-right font-normal">Current</th>
                    <th className="py-1.5 text-right font-normal">Non-current</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.history.length ? data.history : [rf]).slice(-12).map((h) => (
                    <tr key={h.month} className={`border-b border-slate-100 ${h.month === data.month ? 'bg-indigo-50/50' : ''}`}>
                      <td className="py-1 pr-3 whitespace-nowrap">{monthLabel(h.month)}</td>
                      <td className="py-1 pr-3 text-right">{money(h.opening)}</td>
                      <td className="py-1 pr-3 text-right">{h.additions ? money(h.additions) : ''}</td>
                      <td className="py-1 pr-3 text-right">{h.amortization ? money(h.amortization) : ''}</td>
                      <td className="py-1 pr-3 text-right">{h.impairment ? money(h.impairment) : ''}</td>
                      <td className="py-1 pr-3 text-right font-medium">{money(h.closing)}</td>
                      <td className="py-1 pr-3 text-right">{money(h.current)}</td>
                      <td className="py-1 text-right">{money(h.noncurrent)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="space-y-4">
              <div>
                <div className="mb-1 text-xs font-semibold text-slate-500">Balance by amortization type</div>
                <table className="w-full bg-panel text-xs">
                  <tbody>
                    {data.byType.map((t) => (
                      <tr key={t.typeName} className="border-b border-slate-100">
                        <td className="py-1 pr-2">
                          {t.typeName} <span className="text-slate-400">({t.count})</span>
                        </td>
                        <td className="py-1 text-right">{money(t.remaining)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div>
                <div className="mb-1 text-xs font-semibold text-slate-500">When today's balance will be expensed</div>
                <Bars height={48} data={data.waterfall.map((w) => ({ label: w.year, value: w.amount }))} />
                <div className="mt-1 flex justify-between text-[11px] text-slate-400">
                  {data.waterfall.map((w) => (
                    <span key={w.year} title={money(w.amount)}>
                      {w.year}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 px-6 py-2 text-xs">
            <select className="select" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
              <option value="open">With a balance</option>
              <option value="all">All commissions</option>
              {(Object.keys(STATUS_LABEL) as RegisterRow['status'][]).map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
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
            <input className="input w-56" placeholder="Search deal, payee, department" value={search} onChange={(e) => setSearch(e.target.value)} />
            <span className="text-slate-400">{rows.length} shown</span>
          </div>
          <div className="px-6 pb-6">
            <table className="w-full bg-panel text-xs">
              <thead className="text-left text-slate-400">
                <tr className="border-b border-slate-200">
                  <th className="py-1.5 pr-3 font-normal">Deal</th>
                  <th className="py-1.5 pr-3 font-normal">Payee</th>
                  <th className="py-1.5 pr-3 font-normal">Type / method</th>
                  <th className="py-1.5 pr-3 text-right font-normal">Capitalized</th>
                  <th className="py-1.5 pr-3 font-normal">Period</th>
                  <th className="py-1.5 pr-3 text-right font-normal">Amortized</th>
                  <th className="py-1.5 pr-3 text-right font-normal">This month</th>
                  <th className="py-1.5 pr-3 text-right font-normal">Remaining</th>
                  <th className="py-1.5 pr-3 text-right font-normal">Current</th>
                  <th className="py-1.5 pr-3 text-right font-normal">Non-current</th>
                  <th className="py-1.5 pr-3 font-normal">Status</th>
                  <th className="py-1.5 font-normal" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const pending = r.writtenOffMonth && data.openMonth && r.writtenOffMonth >= data.openMonth;
                  return (
                    <tr key={r.id} className="border-b border-slate-100 align-top">
                      <td className="py-1 pr-3 whitespace-nowrap">{r.dealKey ?? '—'}</td>
                      <td className="py-1 pr-3">
                        <div className="whitespace-nowrap">{r.payee}</div>
                        <div className="text-[11px] text-slate-400">{r.department}</div>
                      </td>
                      <td className="py-1 pr-3">
                        <div>{r.typeName}</div>
                        <div className="text-[11px] text-slate-400">{r.methodName}</div>
                      </td>
                      <td className="py-1 pr-3 text-right">
                        <div>{money(r.amount)}</div>
                        <div className="text-[11px] text-slate-400">{monthLabel(r.capitalizedMonth)}</div>
                      </td>
                      <td className="py-1 pr-3 whitespace-nowrap">
                        {monthLabel(r.startMonth)} – {monthLabel(r.endMonth)}
                        <div className="text-[11px] text-slate-400">{r.months} months</div>
                      </td>
                      <td className="py-1 pr-3 text-right">{money(r.amortizedToDate)}</td>
                      <td className="py-1 pr-3 text-right">{r.amortizationThisMonth ? money(r.amortizationThisMonth) : ''}</td>
                      <td className="py-1 pr-3 text-right font-medium">{money(r.remaining)}</td>
                      <td className="py-1 pr-3 text-right">{money(r.current)}</td>
                      <td className="py-1 pr-3 text-right">{money(r.noncurrent)}</td>
                      <td className="py-1 pr-3">
                        <span className={`rounded px-1.5 py-0.5 text-[10px] ${STATUS_TONE[r.status]}`}>{STATUS_LABEL[r.status]}</span>
                        {pending && (
                          <div className="mt-0.5 text-[10px] text-rose-700" title={r.writeOffReason ?? ''}>
                            Write-off pending {monthLabel(r.writtenOffMonth!)}
                          </div>
                        )}
                        {r.status === 'written_off' && r.writeOffReason && <div className="mt-0.5 text-[10px] text-slate-400">{r.writeOffReason}</div>}
                      </td>
                      <td className="py-1 text-right whitespace-nowrap">
                        {pending ? (
                          <button className="text-slate-400 hover:text-slate-700" onClick={() => undo(r)}>
                            Undo
                          </button>
                        ) : (
                          r.remaining !== 0 &&
                          data.openMonth && (
                            <button className="text-slate-400 hover:text-rose-600" onClick={() => writeOff(r)} title="Customer churned or contract ended early">
                              Write off
                            </button>
                          )
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t border-slate-300 font-medium">
                  <td colSpan={3} className="py-1.5 pr-3">
                    Total
                  </td>
                  <td className="py-1.5 pr-3 text-right">{money(sum((r) => r.amount))}</td>
                  <td />
                  <td className="py-1.5 pr-3 text-right">{money(sum((r) => r.amortizedToDate))}</td>
                  <td className="py-1.5 pr-3 text-right">{money(sum((r) => r.amortizationThisMonth))}</td>
                  <td className="py-1.5 pr-3 text-right">{money(sum((r) => r.remaining))}</td>
                  <td className="py-1.5 pr-3 text-right">{money(sum((r) => r.current))}</td>
                  <td className="py-1.5 pr-3 text-right">{money(sum((r) => r.noncurrent))}</td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
