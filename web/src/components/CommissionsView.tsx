import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type CommissionLine, type CommissionRun, type ImportDetail, type ImportSummary } from '../api';
import { PeriodPicker } from './PeriodPicker';

const money = (n: number | null | undefined) => (n === null || n === undefined ? '' : n.toLocaleString(undefined, { style: 'currency', currency: 'USD' }));
const pct = (n: number | null) => (n === null ? '' : `${Math.round(n * 10000) / 100}%`);
const num = (n: number | null) => (n === null ? '' : n.toLocaleString());

interface Draft {
  name: string;
  importId: string;
  repField: string;
  payees: { role: string; field: string }[];
  amountField: string;
  dateField: string;
  dealKeyField: string;
  from: string | null;
  to: string | null;
}

/** Guess the obvious columns so most runs are two clicks. */
function guess(imp: ImportDetail): Pick<Draft, 'repField' | 'amountField' | 'dateField' | 'dealKeyField'> {
  const names = imp.columns.map((c) => c.name);
  const find = (re: RegExp, type?: (t: string) => boolean) => names.find((n) => re.test(n) && (!type || type(imp.columns.find((c) => c.name === n)!.type))) ?? '';
  const isNum = (t: string) => ['currency', 'decimal', 'integer'].includes(t);
  const isDate = (t: string) => t === 'date' || t === 'datetime';
  return {
    repField: find(/\b(rep|owner|salesperson|employee|ae)\b/i) || find(/rep|owner/i),
    amountField: find(/\b(acv|amount|arr|bookings?|value)\b/i, isNum) || find(/./, isNum),
    dateField: find(/close|booked|signed/i, isDate) || find(/./, isDate),
    dealKeyField: find(/\b(deal|opportunity|opp)\b.*\b(id|number|#)/i) || find(/^id$/i),
  };
}

export function CommissionsView() {
  const [runs, setRuns] = useState<CommissionRun[]>([]);
  const [imports, setImports] = useState<ImportSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | 'new' | null>(null);
  const [run, setRun] = useState<(CommissionRun & { lines: CommissionLine[] }) | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [importDetail, setImportDetail] = useState<ImportDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');
  const [onlySplit, setOnlySplit] = useState(false);

  const refresh = useCallback(async () => {
    const r = await api.listCommissionRuns();
    setRuns(r);
    return r;
  }, []);

  useEffect(() => {
    Promise.all([refresh(), api.listImports()])
      .then(([r, imps]) => {
        setImports(imps);
        if (r.length) setSelectedId(r[0].id);
        else setSelectedId('new');
      })
      .catch((e) => setError(e.message));
  }, [refresh]);

  useEffect(() => {
    if (!selectedId || selectedId === 'new') {
      setRun(null);
      return;
    }
    api.getCommissionRun(selectedId).then(setRun).catch((e) => setError(e.message));
  }, [selectedId]);

  // A fresh draft points at the first import and guesses its columns.
  useEffect(() => {
    if (selectedId !== 'new') return;
    const first = imports[0];
    setDraft({ name: '', importId: first?.id ?? '', repField: '', payees: [], amountField: '', dateField: '', dealKeyField: '', from: null, to: null });
  }, [selectedId, imports]);

  useEffect(() => {
    if (!draft?.importId) {
      setImportDetail(null);
      return;
    }
    api
      .getImport(draft.importId)
      .then((d) => {
        setImportDetail(d);
        setDraft((cur) => (cur && cur.importId === d.id && !cur.repField && !cur.amountField ? { ...cur, ...guess(d), name: cur.name || `${d.name} commissions` } : cur));
      })
      .catch((e) => setError(e.message));
  }, [draft?.importId]);

  const columns = importDetail?.columns ?? [];
  const textCols = columns.filter((c) => c.type === 'text');
  const numCols = columns.filter((c) => ['currency', 'decimal', 'integer', 'percent'].includes(c.type));
  const dateCols = columns.filter((c) => c.type === 'date' || c.type === 'datetime');

  const create = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.createCommissionRun({
        name: draft.name.trim() || 'Commission run',
        importId: draft.importId,
        repField: draft.repField,
        payees: draft.payees.filter((p) => p.role.trim() && p.field),
        amountField: draft.amountField,
        dateField: draft.dateField || null,
        dealKeyField: draft.dealKeyField || null,
        from: draft.from,
        to: draft.to,
      });
      await refresh();
      setSelectedId(created.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (r: CommissionRun) => {
    if (!window.confirm(`Delete run "${r.name}" and its ${r.lineCount} lines?`)) return;
    await api.deleteCommissionRun(r.id);
    const list = await refresh();
    setSelectedId(list[0]?.id ?? 'new');
  };

  const byPayee = useMemo(() => {
    if (!run) return [];
    const m = new Map<string, { payee: string; role: string; plan: string; deals: Set<number>; amount: number; payout: number; unpaid: number }>();
    for (const l of run.lines) {
      const k = `${l.payee.toLowerCase()}|${l.role}`;
      let t = m.get(k);
      if (!t) {
        t = { payee: l.payee, role: l.role, plan: l.planName ?? '', deals: new Set(), amount: 0, payout: 0, unpaid: 0 };
        m.set(k, t);
      }
      if (!t.deals.has(l.rowIndex)) {
        t.deals.add(l.rowIndex);
        t.amount += l.dealAmount ?? 0;
      }
      if (l.payout === null) t.unpaid++;
      else t.payout += l.payout;
      if (!t.plan && l.planName) t.plan = l.planName;
    }
    return [...m.values()].sort((a, b) => b.payout - a.payout || a.payee.localeCompare(b.payee));
  }, [run]);

  const visibleLines = useMemo(() => {
    if (!run) return [];
    const q = filter.trim().toLowerCase();
    return run.lines.filter((l) => (!onlySplit || l.split) && (!q || `${l.payee} ${l.dealKey ?? ''} ${l.planName ?? ''} ${l.note ?? ''}`.toLowerCase().includes(q)));
  }, [run, filter, onlySplit]);

  const splitCount = run ? new Set(run.lines.filter((l) => l.split).map((l) => `${l.rowIndex}|${l.payee}`)).size : 0;
  const unpaidCount = run ? run.lines.filter((l) => l.payout === null).length : 0;

  return (
    <div className="flex h-full">
      <aside className="flex w-64 shrink-0 flex-col border-r border-slate-200 bg-white">
        <div className="flex items-center border-b border-slate-200 px-3 py-2">
          <span className="text-sm font-semibold">Commission runs</span>
          <div className="flex-1" />
          <button className="btn btn-sm btn-primary" onClick={() => setSelectedId('new')}>
            + New run
          </button>
        </div>
        <div className="flex-1 overflow-auto p-2">
          {runs.map((r) => (
            <button
              key={r.id}
              onClick={() => setSelectedId(r.id)}
              className={`block w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-slate-100 ${selectedId === r.id ? 'bg-indigo-50 text-indigo-700' : 'text-slate-700'}`}
            >
              <div className="truncate font-medium">{r.name}</div>
              <div className="truncate text-xs text-slate-400">
                {money(r.totalPayout)} · {r.dealCount} deals · {new Date(r.createdAt).toLocaleDateString()}
              </div>
            </button>
          ))}
          {runs.length === 0 && <div className="px-2 py-4 text-xs text-slate-400">No runs yet.</div>}
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {error && (
          <div className="border-b border-red-200 bg-red-50 px-4 py-1.5 text-xs text-red-700">
            {error}{' '}
            <button className="underline" onClick={() => setError(null)}>
              dismiss
            </button>
          </div>
        )}

        {selectedId === 'new' && draft && (
          <div className="flex-1 overflow-auto p-6">
            <div className="max-w-2xl space-y-5">
              <div>
                <div className="text-base font-semibold">New commission run</div>
                <div className="text-xs text-slate-500">
                  One line per person per deal. Each person's rate comes from the comp plan in force on the deal's close date; a deal that crosses a tier is split
                  into one line per band. Attainment accrues in close-date order over the deals in the run.
                </div>
              </div>
              {imports.length === 0 ? (
                <div className="rounded-lg border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-400">Import a deals file first.</div>
              ) : (
                <>
                  <label className="block text-sm">
                    <span className="text-xs text-slate-500">Name</span>
                    <input className="input mt-1 w-full" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="FY2026 commissions" />
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="block text-sm">
                      <span className="text-xs text-slate-500">Deals import</span>
                      <select
                        className="select mt-1 w-full"
                        value={draft.importId}
                        onChange={(e) => setDraft({ ...draft, importId: e.target.value, repField: '', amountField: '', dateField: '', dealKeyField: '', payees: [] })}
                      >
                        {imports.map((i) => (
                          <option key={i.id} value={i.id}>
                            {i.name} ({i.rowCount.toLocaleString()} rows)
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block text-sm">
                      <span className="text-xs text-slate-500">Close date range</span>
                      <div className="mt-1">
                        <PeriodPicker from={draft.from} to={draft.to} onChange={(from, to) => setDraft({ ...draft, from, to })} compact />
                      </div>
                    </label>
                    <Field label="Rep column" value={draft.repField} onChange={(v) => setDraft({ ...draft, repField: v })} options={textCols.map((c) => c.name)} required />
                    <Field label="Amount column" value={draft.amountField} onChange={(v) => setDraft({ ...draft, amountField: v })} options={numCols.map((c) => c.name)} required />
                    <Field label="Close date column" value={draft.dateField} onChange={(v) => setDraft({ ...draft, dateField: v })} options={dateCols.map((c) => c.name)} />
                    <Field label="Deal ID column" value={draft.dealKeyField} onChange={(v) => setDraft({ ...draft, dealKeyField: v })} options={columns.map((c) => c.name)} />
                  </div>
                  <div>
                    <div className="flex items-center">
                      <span className="text-xs text-slate-500">Other people paid on each deal</span>
                      <div className="flex-1" />
                      <button className="btn btn-sm" onClick={() => setDraft({ ...draft, payees: [...draft.payees, { role: '', field: '' }] })}>
                        + Add
                      </button>
                    </div>
                    <div className="mt-1 text-xs text-slate-400">E.g. a Sales Engineer or Manager column. Each gets their own line under their own plan.</div>
                    {draft.payees.map((p, i) => (
                      <div key={i} className="mt-2 flex items-center gap-2">
                        <input
                          className="input w-40"
                          placeholder="Role, e.g. SE"
                          value={p.role}
                          onChange={(e) => setDraft({ ...draft, payees: draft.payees.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)) })}
                        />
                        <select className="select flex-1" value={p.field} onChange={(e) => setDraft({ ...draft, payees: draft.payees.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)) })}>
                          <option value="">Pick a column…</option>
                          {textCols.map((c) => (
                            <option key={c.name} value={c.name}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                        <button className="text-slate-400 hover:text-rose-600" onClick={() => setDraft({ ...draft, payees: draft.payees.filter((_, j) => j !== i) })}>
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center gap-2">
                    <button className="btn btn-primary" disabled={busy || !draft.importId || !draft.repField || !draft.amountField} onClick={create}>
                      {busy ? 'Calculating…' : 'Calculate'}
                    </button>
                    {runs.length > 0 && (
                      <button className="btn" onClick={() => setSelectedId(runs[0].id)}>
                        Cancel
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {selectedId !== 'new' && run && (
          <>
            <div className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">{run.name}</div>
                <div className="truncate text-xs text-slate-400">
                  {run.importName} · {run.config.repField}
                  {run.config.payees.length ? ` + ${run.config.payees.map((p) => p.role).join(', ')}` : ''} · {run.config.amountField}
                  {run.config.from || run.config.to ? ` · ${run.config.from ?? '…'} → ${run.config.to ?? '…'}` : ' · all dates'} · {new Date(run.createdAt).toLocaleString()}
                </div>
              </div>
              <div className="flex-1" />
              <button className="btn btn-sm" onClick={() => api.exportCommissionRun(run.id)}>
                Export CSV
              </button>
              <button className="btn btn-sm" onClick={() => remove(run)}>
                Delete
              </button>
            </div>

            <div className="flex-1 overflow-auto">
              <div className="grid grid-cols-4 gap-3 p-4">
                <Stat label="Total payout" value={money(run.totalPayout)} />
                <Stat label="Deals" value={run.dealCount.toLocaleString()} sub={`${run.lineCount.toLocaleString()} lines`} />
                <Stat label="Split by a tier" value={splitCount.toLocaleString()} sub="person-deals crossing a threshold" />
                <Stat label="Needs attention" value={unpaidCount.toLocaleString()} sub="lines with no payout" tone={unpaidCount ? 'warn' : undefined} />
              </div>

              {run.warnings.length > 0 && (
                <div className="mx-4 mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  {run.warnings.map((w, i) => (
                    <div key={i}>{w}</div>
                  ))}
                </div>
              )}

              <div className="px-4 pb-4">
                <div className="mb-1 text-xs font-semibold text-slate-500">By person</div>
                <table className="w-full bg-white text-xs">
                  <thead className="text-left text-slate-400">
                    <tr className="border-b border-slate-200">
                      <th className="py-1.5 pr-3 font-normal">Person</th>
                      <th className="py-1.5 pr-3 font-normal">Role</th>
                      <th className="py-1.5 pr-3 font-normal">Plan</th>
                      <th className="py-1.5 pr-3 text-right font-normal">Deals</th>
                      <th className="py-1.5 pr-3 text-right font-normal">Deal amount</th>
                      <th className="py-1.5 pr-3 text-right font-normal">Payout</th>
                      <th className="py-1.5 pr-3 text-right font-normal">Effective rate</th>
                      <th className="py-1.5 text-right font-normal">Unpaid lines</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byPayee.map((t) => (
                      <tr key={`${t.payee}|${t.role}`} className="border-b border-slate-100 hover:bg-slate-50">
                        <td className="py-1.5 pr-3 font-medium text-slate-800">
                          <button className="hover:underline" onClick={() => setFilter(t.payee)}>
                            {t.payee}
                          </button>
                        </td>
                        <td className="py-1.5 pr-3">{t.role}</td>
                        <td className="py-1.5 pr-3">{t.plan || <span className="text-rose-600">none</span>}</td>
                        <td className="py-1.5 pr-3 text-right">{t.deals.size}</td>
                        <td className="py-1.5 pr-3 text-right">{money(t.amount)}</td>
                        <td className="py-1.5 pr-3 text-right font-medium">{money(t.payout)}</td>
                        <td className="py-1.5 pr-3 text-right">{t.amount ? pct(t.payout / t.amount) : ''}</td>
                        <td className={`py-1.5 text-right ${t.unpaid ? 'text-amber-700' : 'text-slate-400'}`}>{t.unpaid || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="px-4 pb-6">
                <div className="mb-1 flex items-center gap-2">
                  <div className="text-xs font-semibold text-slate-500">Commission lines</div>
                  <div className="flex-1" />
                  <label className="flex items-center gap-1 text-xs text-slate-500">
                    <input type="checkbox" checked={onlySplit} onChange={(e) => setOnlySplit(e.target.checked)} /> only split deals
                  </label>
                  <input className="input w-56" placeholder="Filter by person, deal, plan…" value={filter} onChange={(e) => setFilter(e.target.value)} />
                </div>
                <table className="w-full bg-white text-xs">
                  <thead className="text-left text-slate-400">
                    <tr className="border-b border-slate-200">
                      <th className="py-1.5 pr-3 font-normal">Deal</th>
                      <th className="py-1.5 pr-3 font-normal">Closed</th>
                      <th className="py-1.5 pr-3 text-right font-normal">Deal amount</th>
                      <th className="py-1.5 pr-3 font-normal">Person</th>
                      <th className="py-1.5 pr-3 font-normal">Role</th>
                      <th className="py-1.5 pr-3 font-normal">Plan</th>
                      <th className="py-1.5 pr-3 font-normal">Tier</th>
                      <th className="py-1.5 pr-3 text-right font-normal">Amount</th>
                      <th className="py-1.5 pr-3 text-right font-normal">Rate</th>
                      <th className="py-1.5 pr-3 text-right font-normal">Payout</th>
                      <th className="py-1.5 pr-3 text-right font-normal">Attainment after</th>
                      <th className="py-1.5 font-normal">Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleLines.map((l) => (
                      <tr key={l.id} className={`border-b border-slate-100 ${l.payout === null ? 'bg-amber-50/60' : l.split ? 'bg-indigo-50/40' : ''}`}>
                        <td className="py-1 pr-3 whitespace-nowrap">{l.dealKey ?? `row ${l.rowIndex + 1}`}</td>
                        <td className="py-1 pr-3 whitespace-nowrap">{l.dealDate ?? ''}</td>
                        <td className="py-1 pr-3 text-right">{money(l.dealAmount)}</td>
                        <td className="py-1 pr-3 whitespace-nowrap font-medium text-slate-800">{l.payee}</td>
                        <td className="py-1 pr-3">{l.role}</td>
                        <td className="py-1 pr-3">{l.planName ?? ''}</td>
                        <td className="py-1 pr-3 whitespace-nowrap">
                          {l.method === 'flat' ? 'flat' : l.method === 'none' ? '' : `${num(l.tierFrom)} – ${l.tierTo === null ? '∞' : num(l.tierTo)}`}
                          {l.split ? <span className="ml-1 rounded bg-indigo-100 px-1 text-[10px] text-indigo-700">split</span> : null}
                        </td>
                        <td className="py-1 pr-3 text-right">{money(l.amount)}</td>
                        <td className="py-1 pr-3 text-right">{pct(l.rate)}</td>
                        <td className="py-1 pr-3 text-right font-medium">{money(l.payout)}</td>
                        <td className="py-1 pr-3 text-right text-slate-500">{money(l.cumulativeAfter)}</td>
                        <td className={`py-1 ${l.payout === null ? 'text-amber-800' : 'text-slate-400'}`}>{l.note ?? ''}</td>
                      </tr>
                    ))}
                    {visibleLines.length === 0 && (
                      <tr>
                        <td colSpan={12} className="py-6 text-center text-slate-400">
                          No lines match.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function Field({ label, value, onChange, options, required }: { label: string; value: string; onChange: (v: string) => void; options: string[]; required?: boolean }) {
  return (
    <label className="block text-sm">
      <span className="text-xs text-slate-500">
        {label}
        {required ? '' : ' (optional)'}
      </span>
      <select className="select mt-1 w-full" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{required ? 'Pick a column…' : 'None'}</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'warn' }) {
  return (
    <div className={`rounded-lg border bg-white px-3 py-2 ${tone === 'warn' ? 'border-amber-200' : 'border-slate-200'}`}>
      <div className="text-xs text-slate-400">{label}</div>
      <div className={`text-lg font-semibold ${tone === 'warn' ? 'text-amber-700' : 'text-slate-800'}`}>{value}</div>
      {sub && <div className="text-[11px] text-slate-400">{sub}</div>}
    </div>
  );
}
