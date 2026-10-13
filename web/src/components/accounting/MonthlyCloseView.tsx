import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, type ClosePreview, type PeriodsPayload } from '../../api';
import { ErrorBar, JournalTable, PageHeader, Stat, Warnings, money, monthLabel } from './ui';

/** Process Monthly Accounting: preview and close the next month, and the history of closed months. */
export function MonthlyCloseView({ onOpenTypes, onOpenRegister }: { onOpenTypes: () => void; onOpenRegister: () => void }) {
  const [periods, setPeriods] = useState<PeriodsPayload | null>(null);
  const [month, setMonth] = useState<string | null>(null);
  const [runIds, setRunIds] = useState<string[] | null>(null);
  const [preview, setPreview] = useState<ClosePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showLines, setShowLines] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPeriods = useCallback(async () => {
    const p = await api.listPeriods();
    setPeriods(p);
    setMonth(p.nextMonth);
    return p;
  }, []);
  useEffect(() => {
    loadPeriods().catch((e) => setError(e.message));
  }, [loadPeriods]);

  useEffect(() => {
    if (!month) return;
    // Only the latest request may update the screen; an older one can land last.
    let cancelled = false;
    setLoading(true);
    api
      .previewClose(month, runIds)
      .then((p) => {
        if (cancelled) return;
        setPreview(p);
        setError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setPreview(null);
        setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [month, runIds, periods]);

  const close = async () => {
    if (!month || !preview) return;
    if (!window.confirm(`Close ${monthLabel(month)}? This books ${money(preview.totals.accrued)} of commissions, ${money(preview.totals.amortization)} of amortization${preview.totals.impairment ? ` and ${money(preview.totals.impairment)} of write-offs` : ''}, and locks the month.`)) return;
    setBusy(true);
    try {
      await api.closeMonth(month, runIds);
      await loadPeriods();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const reopen = async (m: string) => {
    if (!window.confirm(`Reopen ${monthLabel(m)}? Its journals and the commissions it added to the register are removed, manual amortizations it booked go back to pending, and you can close it again.`)) return;
    try {
      try {
        await api.reopenMonth(m);
      } catch (e) {
        const msg = (e as Error).message;
        if (!/modified, transferred or written off/.test(msg) || !window.confirm(`${msg}\n\nReopen anyway?`)) throw e;
        await api.reopenMonth(m, true);
      }
      await loadPeriods();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!periods) return <div className="p-6 text-sm text-slate-400">{error ?? 'Loading…'}</div>;
  const first = periods.periods.length === 0;
  const allRuns = preview?.runs ?? [];
  const chosen = runIds ?? allRuns.map((r) => r.id);
  const capLines = preview?.booked.filter((b) => b.treatment === 'capitalize').length ?? 0;
  const expLines = preview?.booked.filter((b) => b.treatment === 'expense').length ?? 0;
  const late = preview?.booked.filter((b) => b.late).length ?? 0;

  return (
    <div className="flex h-full flex-col overflow-auto">
      <PageHeader
        section="Accounting"
        title="Process Monthly Accounting"
        hint="Close one month at a time: book the commissions approved for that payroll (capitalized into the register or expensed), recognize the month's amortization and any write-offs, reclass the balance between current and non-current, and lock the month."
      />
      <ErrorBar error={error} onDismiss={() => setError(null)} />

      <div className="mx-auto w-full max-w-6xl space-y-6 p-6">
        <section className="flex flex-wrap items-end gap-4 rounded-lg border border-slate-200 bg-panel p-4 text-xs">
          <label className="text-slate-600">
            Month to close
            {first ? (
              <input type="month" className="input mt-1 block" value={month ?? ''} onChange={(e) => e.target.value && setMonth(e.target.value)} />
            ) : (
              <div className="mt-1 text-base font-semibold text-slate-800">{month && monthLabel(month)}</div>
            )}
          </label>
          {first && (
            <div className="max-w-sm text-slate-400">
              This is your first close, so it sets where the register starts. Commissions paid before it stay out of the register.
              {periods.firstPayMonth && ` Your earliest pay month is ${monthLabel(periods.firstPayMonth)}.`}
            </div>
          )}
          <div className="text-slate-600">
            Commission runs included
            <div className="mt-1 flex flex-wrap gap-2">
              {allRuns.map((r) => (
                <label key={r.id} className="flex items-center gap-1 rounded border border-slate-200 px-2 py-0.5">
                  <input
                    type="checkbox"
                    checked={chosen.includes(r.id)}
                    onChange={(e) => {
                      const next = e.target.checked ? [...chosen, r.id] : chosen.filter((x) => x !== r.id);
                      setRunIds(next.length === allRuns.length ? null : next);
                    }}
                  />
                  {r.name}
                </label>
              ))}
              {allRuns.length === 0 && <span className="text-slate-400">No commission runs yet.</span>}
            </div>
          </div>
          <div className="flex-1" />
          <button className="btn btn-primary" disabled={busy || loading || !preview || !preview.balanced} onClick={close}>
            {busy ? 'Closing…' : `Close ${month ? monthLabel(month) : ''}`}
          </button>
        </section>

        {preview && (
          <>
            <div className="grid grid-cols-6 gap-3">
              <Stat label="Accrue for payroll" value={money(preview.totals.accrued)} sub={`${preview.booked.length} lines${late ? `, ${late} late` : ''}`} />
              <Stat
                label="Capitalized"
                value={money(preview.totals.capitalized + (preview.totals.manual ?? 0))}
                sub={`${capLines} new in the register${preview.totals.manual ? `, incl. ${money(preview.totals.manual)} entered by hand` : ''}`}
              />
              <Stat label="Expensed" value={money(preview.totals.expensed)} sub={`${expLines} lines`} />
              <Stat label="Amortization" value={money(preview.totals.amortization)} />
              <Stat label="Written off" value={money(preview.totals.impairment)} tone={preview.totals.impairment ? 'warn' : undefined} />
              <Stat label="Closing balance" value={money(preview.rollforward.closing)} sub={`${money(preview.rollforward.current)} current`} />
            </div>

            <section className="space-y-2">
              <div className="text-xs font-semibold text-slate-500">Checks before closing</div>
              <ul className="space-y-1 text-xs">
                <Check ok={preview.balanced} text={preview.balanced ? 'Every journal balances.' : 'A journal does not balance; the month cannot be closed.'} />
                <Check
                  ok={Math.round((preview.rollforward.opening + preview.rollforward.additions - preview.rollforward.amortization - preview.rollforward.impairment) * 100) === Math.round(preview.rollforward.closing * 100)}
                  text={`Register rolls forward: ${money(preview.rollforward.opening)} + ${money(preview.rollforward.additions)} − ${money(preview.rollforward.amortization)} − ${money(preview.rollforward.impairment)} = ${money(preview.rollforward.closing)}.`}
                />
                <Check
                  ok={preview.unmapped.length === 0}
                  warn
                  text={
                    preview.unmapped.length ? (
                      <>
                        Roles with no amortization type: {preview.unmapped.join(', ')}.{' '}
                        <button className="underline" onClick={onOpenTypes}>
                          Map them
                        </button>
                      </>
                    ) : (
                      'Every role has an amortization type.'
                    )
                  }
                />
                {preview.excluded.length > 0 && <Check ok={false} warn text={`${preview.excluded.length} line${preview.excluded.length === 1 ? '' : 's'} paid before the register starts and will not be booked.`} />}
              </ul>
              <Warnings items={preview.warnings} />
            </section>

            <section>
              <div className="mb-1 flex items-center gap-2 text-xs font-semibold text-slate-500">
                <span>Journals for {month && monthLabel(month)}</span>
                <span className="font-normal text-slate-400">dated the last day of the month</span>
              </div>
              <JournalTable entries={preview.entries} empty="Nothing to book this month." />
            </section>

            <section>
              <button className="text-xs font-semibold text-slate-500 hover:text-slate-700" onClick={() => setShowLines(!showLines)}>
                {showLines ? '▾' : '▸'} Lines booked this month ({preview.booked.length})
              </button>
              {showLines && (
                <table className="mt-1 w-full bg-panel text-xs">
                  <thead className="text-left text-slate-400">
                    <tr className="border-b border-slate-200">
                      <th className="py-1.5 pr-3 font-normal">Deal</th>
                      <th className="py-1.5 pr-3 font-normal">Payee</th>
                      <th className="py-1.5 pr-3 font-normal">Type</th>
                      <th className="py-1.5 pr-3 font-normal">Treatment</th>
                      <th className="py-1.5 pr-3 font-normal">Method</th>
                      <th className="py-1.5 pr-3 font-normal">Pay month</th>
                      <th className="py-1.5 text-right font-normal">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.booked.map((b) => (
                      <tr key={`${b.sourceKey}:${b.adjustment}`} className="border-b border-slate-100">
                        <td className="py-1 pr-3">{b.dealKey ?? '—'}</td>
                        <td className="py-1 pr-3">
                          {b.payee} <span className="text-slate-400">· {b.department}</span>
                        </td>
                        <td className="py-1 pr-3">{b.typeName}</td>
                        <td className="py-1 pr-3">
                          <span className={`rounded px-1 text-[10px] ${b.treatment === 'expense' ? 'bg-rose-100 text-rose-700' : 'bg-emerald-100 text-emerald-700'}`}>{b.treatment}</span>
                          {b.note && <span className="ml-1 text-[11px] text-slate-400">{b.note}</span>}
                        </td>
                        <td className="py-1 pr-3 text-slate-500">{b.methodName}</td>
                        <td className="py-1 pr-3">
                          {monthLabel(b.payMonth)}
                          {b.adjustment ? (
                            <span className="ml-1 rounded bg-amber-100 px-1 text-[10px] text-amber-800">recalculated</span>
                          ) : (
                            b.late && <span className="ml-1 rounded bg-amber-100 px-1 text-[10px] text-amber-800">late</span>
                          )}
                        </td>
                        <td className="py-1 text-right">{money(b.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </>
        )}
        {loading && !preview && <div className="text-sm text-slate-400">Calculating…</div>}

        <section>
          <div className="mb-1 flex items-center text-xs font-semibold text-slate-500">
            <span>Closed months</span>
            <div className="flex-1" />
            {periods.periods.length > 0 && (
              <button className="font-normal underline" onClick={onOpenRegister}>
                Open the register
              </button>
            )}
          </div>
          <table className="w-full bg-panel text-xs">
            <thead className="text-left text-slate-400">
              <tr className="border-b border-slate-200">
                <th className="py-1.5 pr-3 font-normal">Month</th>
                <th className="py-1.5 pr-3 text-right font-normal">Accrued</th>
                <th className="py-1.5 pr-3 text-right font-normal">Capitalized</th>
                <th className="py-1.5 pr-3 text-right font-normal">Expensed</th>
                <th className="py-1.5 pr-3 text-right font-normal">Amortization</th>
                <th className="py-1.5 pr-3 text-right font-normal">Written off</th>
                <th className="py-1.5 pr-3 text-right font-normal">Closing balance</th>
                <th className="py-1.5 pr-3 font-normal">Closed by</th>
                <th className="py-1.5 font-normal" />
              </tr>
            </thead>
            <tbody>
              {[...periods.periods].reverse().map((p, i) => (
                <tr key={p.id} className="border-b border-slate-100">
                  <td className="py-1 pr-3 font-medium">{monthLabel(p.month)}</td>
                  <td className="py-1 pr-3 text-right">{money(p.totals?.accrued)}</td>
                  <td className="py-1 pr-3 text-right">{money(p.totals?.capitalized)}</td>
                  <td className="py-1 pr-3 text-right">{money(p.totals?.expensed)}</td>
                  <td className="py-1 pr-3 text-right">{money(p.totals?.amortization)}</td>
                  <td className="py-1 pr-3 text-right">{p.totals?.impairment ? money(p.totals.impairment) : ''}</td>
                  <td className="py-1 pr-3 text-right">{money(p.rollforward?.closing)}</td>
                  <td className="py-1 pr-3 text-slate-400">
                    {p.closedBy} · {new Date(p.createdAt).toLocaleDateString()}
                  </td>
                  <td className="py-1 text-right">
                    {i === 0 && (
                      <button className="text-slate-400 hover:text-rose-600" onClick={() => reopen(p.month)}>
                        Reopen
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {periods.periods.length === 0 && (
                <tr>
                  <td colSpan={9} className="py-4 text-center text-slate-400">
                    No months closed yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}

function Check({ ok, warn, text }: { ok: boolean; warn?: boolean; text: ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <span className={ok ? 'text-emerald-700' : warn ? 'text-amber-700' : 'text-rose-700'}>{ok ? '✓' : warn ? '!' : '✕'}</span>
      <span className="text-slate-600">{text}</span>
    </li>
  );
}
