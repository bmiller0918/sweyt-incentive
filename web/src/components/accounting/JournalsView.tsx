import { useEffect, useMemo, useState } from 'react';
import { api, type JournalEntry, type PeriodsPayload, type ReclassRow } from '../../api';
import { ErrorBar, JournalTable, PageHeader, money, monthLabel } from './ui';

/** Months the user can look at: every closed month, then the open one (as a preview). */
function useMonths() {
  const [periods, setPeriods] = useState<PeriodsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .listPeriods()
      .then(setPeriods)
      .catch((e) => setError(e.message));
  }, []);
  const months = periods ? [...periods.periods.map((p) => p.month), ...(periods.periods.length ? [periods.nextMonth] : [])] : [];
  return { periods, months, error, setError };
}

/** Monthly Journals: every entry a month posts, plus the net by account, ready to export to the ERP. */
export function JournalsView() {
  const { periods, months, error, setError } = useMonths();
  const [month, setMonth] = useState<string | null>(null);
  const [data, setData] = useState<{ entries: JournalEntry[]; closed: boolean } | null>(null);

  useEffect(() => {
    if (!month && months.length) setMonth(periods!.periods.length ? periods!.periods[periods!.periods.length - 1].month : months[0]);
  }, [months, month, periods]);
  useEffect(() => {
    if (!month) return;
    api
      .getJournals(month)
      .then(setData)
      .catch((e) => setError(e.message));
  }, [month, setError]);

  const byAccount = useMemo(() => {
    const map = new Map<string, { number: string; account: string; debit: number; credit: number }>();
    for (const e of data?.entries ?? [])
      for (const l of e.lines) {
        const k = `${l.accountNumber ?? ''}|${l.account}`;
        const cur = map.get(k) ?? { number: l.accountNumber ?? '', account: l.account, debit: 0, credit: 0 };
        cur.debit += l.debit;
        cur.credit += l.credit;
        map.set(k, cur);
      }
    return [...map.values()].sort((a, b) => a.number.localeCompare(b.number));
  }, [data]);

  return (
    <div className="flex h-full flex-col overflow-auto">
      <PageHeader
        section="Accounting › Process Monthly Accounting"
        title="Monthly Journals"
        hint="The entries a month posts: accrual of commissions approved for payroll, amortization by department, write-offs, and the current / non-current reclass. Export them in a flat format most ERPs (NetSuite, Intacct, QuickBooks) can import."
      >
        <select className="select" value={month ?? ''} onChange={(e) => setMonth(e.target.value)}>
          {months.map((m) => (
            <option key={m} value={m}>
              {monthLabel(m)}
              {periods?.periods.some((p) => p.month === m) ? '' : ' (open, preview)'}
            </option>
          ))}
        </select>
        <button className="btn btn-sm" disabled={!month} onClick={() => month && api.exportJournals(month)}>
          Export CSV
        </button>
      </PageHeader>
      <ErrorBar error={error} onDismiss={() => setError(null)} />
      {months.length === 0 && periods ? (
        <div className="p-6 text-sm text-slate-400">No months closed yet. Close one under Process Monthly Accounting.</div>
      ) : (
        <div className="mx-auto w-full max-w-6xl space-y-6 p-6">
          {data && !data.closed && <div className="rounded-md border border-sky-300 bg-sky-50 px-3 py-2 text-xs text-sky-800">This month is open: these entries are a preview and will change until the month is closed.</div>}
          <section>
            <div className="mb-1 text-xs font-semibold text-slate-500">Net by account</div>
            <table className="w-full bg-panel text-xs">
              <thead className="text-left text-slate-400">
                <tr className="border-b border-slate-200">
                  <th className="py-1.5 pr-3 font-normal">Account</th>
                  <th className="py-1.5 pr-3 text-right font-normal">Debits</th>
                  <th className="py-1.5 pr-3 text-right font-normal">Credits</th>
                  <th className="py-1.5 text-right font-normal">Net</th>
                </tr>
              </thead>
              <tbody>
                {byAccount.map((a) => (
                  <tr key={a.number + a.account} className="border-b border-slate-100">
                    <td className="py-1 pr-3">
                      <span className="mr-1.5 font-mono text-[11px] text-slate-400">{a.number}</span>
                      {a.account}
                    </td>
                    <td className="py-1 pr-3 text-right">{money(a.debit)}</td>
                    <td className="py-1 pr-3 text-right">{money(a.credit)}</td>
                    <td className="py-1 text-right font-medium">{money(Math.round((a.debit - a.credit) * 100) / 100)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section>
            <div className="mb-1 text-xs font-semibold text-slate-500">Entries</div>
            <JournalTable entries={data?.entries ?? []} />
          </section>
        </div>
      )}
    </div>
  );
}

/** Monthly Reclass: the current / non-current split of the deferred-commission balance, month by month. */
export function ReclassView() {
  const [rows, setRows] = useState<ReclassRow[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .getReclass()
      .then((r) => {
        setRows(r);
        setSelected(r.length ? r[r.length - 1].month : null);
      })
      .catch((e) => setError(e.message));
  }, []);
  const row = rows?.find((r) => r.month === selected);

  return (
    <div className="flex h-full flex-col overflow-auto">
      <PageHeader
        section="Accounting › Process Monthly Accounting"
        title="Monthly Reclass"
        hint="Deferred commissions that will amortize in the next 12 months are a current asset; the rest is non-current. Each close recomputes the current portion from the register's schedules and books the difference. Choose true-up or reverse-and-rebook in Accounting Settings."
      />
      <ErrorBar error={error} onDismiss={() => setError(null)} />
      {rows && rows.length === 0 ? (
        <div className="p-6 text-sm text-slate-400">No months closed yet.</div>
      ) : (
        <div className="mx-auto w-full max-w-5xl space-y-6 p-6">
          <table className="w-full bg-panel text-xs">
            <thead className="text-left text-slate-400">
              <tr className="border-b border-slate-200">
                <th className="py-1.5 pr-3 font-normal">Month</th>
                <th className="py-1.5 pr-3 text-right font-normal">Balance</th>
                <th className="py-1.5 pr-3 text-right font-normal">Current</th>
                <th className="py-1.5 pr-3 text-right font-normal">Non-current</th>
                <th className="py-1.5 pr-3 text-right font-normal">Prior current</th>
                <th className="py-1.5 text-right font-normal">Moved to current</th>
              </tr>
            </thead>
            <tbody>
              {(rows ?? []).map((r) => (
                <tr key={r.month} className={`cursor-pointer border-b border-slate-100 hover:bg-slate-100 ${r.month === selected ? 'bg-indigo-50/50' : ''}`} onClick={() => setSelected(r.month)}>
                  <td className="py-1 pr-3 font-medium">{monthLabel(r.month)}</td>
                  <td className="py-1 pr-3 text-right">{money(r.closing)}</td>
                  <td className="py-1 pr-3 text-right">{money(r.current)}</td>
                  <td className="py-1 pr-3 text-right">{money(r.noncurrent)}</td>
                  <td className="py-1 pr-3 text-right">{r.reclass ? money(r.reclass.priorCurrent) : '—'}</td>
                  <td className="py-1 text-right">{r.reclass ? money(r.reclass.netMove) : 'reclass off'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {row && (
            <section className="space-y-2">
              <div className="text-xs font-semibold text-slate-500">{monthLabel(row.month)} reclass</div>
              {row.reclass && (
                <div className="text-xs text-slate-500">
                  Target current portion {money(row.reclass.target)} (amortization scheduled for the next 12 months). Last month's current portion was {money(row.reclass.priorCurrent)}.
                  {row.reclass.beforeReclass !== 0 && ` After this month's amortization and write-offs the current account held ${money(row.reclass.beforeReclass)}.`}
                </div>
              )}
              <JournalTable entries={row.entries} empty="No reclass needed this month." />
            </section>
          )}
        </div>
      )}
    </div>
  );
}
