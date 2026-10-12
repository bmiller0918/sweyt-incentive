import type { AccountMap, AmortizationMethodDef } from '@commissions/shared';
import { useEffect, useMemo, useState } from 'react';
import { api, type AccountingSettingsRow, type AmortizationMethodRow, type MethodSchedule } from '../../api';
import { Bars, ErrorBar, PageHeader, money, monthLabel } from './ui';

export const KIND_LABELS: Record<AmortizationMethodDef['kind'], string> = {
  straight_line: 'Straight-line',
  yearly_percent: 'Percentage per year',
  monthly_percent: 'Percentage per month',
  immediate: 'Expense immediately',
};

const START_LABELS: Record<AmortizationMethodDef['startBasis'], string> = {
  contract_start: 'the subscription start',
  pay_month: 'the pay month',
  month_after_pay: 'the month after the pay month',
};

/** One line describing a method in plain words. */
export function describeMethod(def: AmortizationMethodDef): string {
  if (def.kind === 'immediate') return 'Expensed in full when accrued; no asset.';
  const from = `from ${START_LABELS[def.startBasis]}`;
  if (def.kind === 'straight_line') {
    if (def.periodBasis === 'fixed_months') return `Evenly over ${def.months} months ${from}.`;
    return def.termMultiplier && def.termMultiplier !== 1 ? `Evenly over ${def.termMultiplier}× the contract term ${from}.` : `Evenly over the contract term ${from}.`;
  }
  if (def.kind === 'yearly_percent') return `${def.yearPercents.map((p) => `${p}%`).join(' / ')} by year, even within each year, ${from}.`;
  return `${def.monthPercents.length} monthly percentages ${from}.`;
}

const blankDef = (): AmortizationMethodDef => ({ kind: 'straight_line', periodBasis: 'contract_term', months: 48, termMultiplier: 1, yearPercents: [25, 25, 25, 25], monthPercents: [], startBasis: 'contract_start' });

const ACCOUNT_ROWS: { key: keyof AccountMap; label: string; hint: string }[] = [
  { key: 'deferredNoncurrent', label: 'Deferred commissions, non-current', hint: 'Asset. New capitalized commissions are debited here.' },
  { key: 'deferredCurrent', label: 'Deferred commissions, current', hint: 'Asset. The part amortizing in the next 12 months, kept right by the reclass.' },
  { key: 'commissionExpense', label: 'Commission expense', hint: 'Expensed commissions (SDRs, practical expedient).' },
  { key: 'amortizationExpense', label: 'Amortization expense', hint: 'Monthly amortization of the asset, by department.' },
  { key: 'impairmentExpense', label: 'Impairment / write-off expense', hint: 'Remaining balance written off on churn or early termination.' },
  { key: 'accruedCommissions', label: 'Accrued commissions', hint: 'Liability credited for everything approved for payroll.' },
];

export function AccountingSettingsView() {
  const [settings, setSettings] = useState<AccountingSettingsRow | null>(null);
  const [methods, setMethods] = useState<AmortizationMethodRow[]>([]);
  const [editing, setEditing] = useState<AmortizationMethodRow | 'new' | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = () =>
    Promise.all([api.getAccountingSettings(), api.listMethods()])
      .then(([s, m]) => {
        setSettings(s);
        setMethods(m);
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    refresh();
  }, []);

  const save = async () => {
    if (!settings) return;
    try {
      const { id: _id, ...body } = settings;
      setSettings(await api.updateAccountingSettings(body));
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!settings) return <div className="p-6 text-sm text-slate-400">{error ?? 'Loading…'}</div>;
  const setAcct = (key: keyof AccountMap, field: 'number' | 'name', v: string) => setSettings({ ...settings, accounts: { ...settings.accounts, [key]: { ...settings.accounts[key], [field]: v } } });

  return (
    <div className="flex h-full flex-col overflow-auto">
      <PageHeader
        section="Accounting"
        title="Accounting Settings"
        hint="Company-wide rules for commissions as costs to obtain a contract (ASC 340-40 / IFRS 15): how amounts amortize, when the one-year expedient applies, how the balance splits between current and non-current, and the GL accounts the journals post to."
      >
        {saved && <span className="text-xs text-emerald-700">Saved</span>}
        <button className="btn btn-primary" onClick={save}>
          Save settings
        </button>
      </PageHeader>
      <ErrorBar error={error} onDismiss={() => setError(null)} />

      <div className="mx-auto w-full max-w-5xl space-y-8 p-6">
        <section className="space-y-3">
          <h2 className="text-base font-semibold">Policy</h2>
          <div className="grid grid-cols-2 gap-4 rounded-lg border border-slate-200 bg-panel p-4 text-xs">
            <label className="text-slate-600">
              Default amortization method
              <select className="select mt-1 block w-full" value={settings.defaultMethodId ?? ''} onChange={(e) => setSettings({ ...settings, defaultMethodId: e.target.value || null })}>
                <option value="">Pick a method…</option>
                {methods.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-slate-400">Used by amortization types that don't pick their own, and by roles with no type.</span>
            </label>
            <label className="text-slate-600">
              Default contract term (months)
              <input type="number" min={1} max={240} className="input mt-1 block w-28" value={settings.defaultTermMonths} onChange={(e) => setSettings({ ...settings, defaultTermMonths: Number(e.target.value) || 1 })} />
              <span className="mt-1 block text-slate-400">When a contract-term method meets a deal with no term in the data.</span>
            </label>
            <label className="col-span-2 flex items-start gap-2 text-slate-600">
              <input type="checkbox" className="mt-0.5" checked={settings.practicalExpedient} onChange={(e) => setSettings({ ...settings, practicalExpedient: e.target.checked })} />
              <span>
                Use the one-year practical expedient
                <span className="block text-slate-400">
                  ASC 340-40-25-4 / IFRS 15.94: expense a commission when its amortization period would be 12 months or less. The period includes expected renewals, so it applies to a
                  12-month deal on a contract-term method, but never to a customer-life method.
                </span>
              </span>
            </label>
            <label className="col-span-2 flex items-start gap-2 text-slate-600">
              <input type="checkbox" className="mt-0.5" checked={settings.reclassEnabled} onChange={(e) => setSettings({ ...settings, reclassEnabled: e.target.checked })} />
              <span>
                Split the balance into current and non-current each month
                <span className="block text-slate-400">The part amortizing in the next 12 months is a current asset; the rest is non-current. Most companies present it this way.</span>
              </span>
            </label>
            {settings.reclassEnabled && (
              <div className="col-span-2 ml-6 space-y-1 text-slate-600">
                <label className="flex items-start gap-2">
                  <input type="radio" className="mt-0.5" checked={settings.reclassMode === 'true_up'} onChange={() => setSettings({ ...settings, reclassMode: 'true_up' })} />
                  <span>
                    True-up <span className="text-slate-400">— one entry moving the change; amortization credits the current account.</span>
                  </span>
                </label>
                <label className="flex items-start gap-2">
                  <input type="radio" className="mt-0.5" checked={settings.reclassMode === 'reverse_rebook'} onChange={() => setSettings({ ...settings, reclassMode: 'reverse_rebook' })} />
                  <span>
                    Reverse and rebook <span className="text-slate-400">— reverse last month's reclass, book this month's in full; everything else posts to non-current.</span>
                  </span>
                </label>
              </div>
            )}
          </div>
        </section>

        <section className="space-y-3">
          <div className="flex items-center">
            <div>
              <h2 className="text-base font-semibold">Amortization methods</h2>
              <p className="text-xs text-slate-500">How one capitalized commission spreads over months. Amortization types pick one; build your own for ramped or front-loaded deals.</p>
            </div>
            <div className="flex-1" />
            <button className="btn btn-primary" onClick={() => setEditing('new')}>
              + New method
            </button>
          </div>
          <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-panel text-sm">
            {methods.map((m) => (
              <li key={m.id} className="flex items-start gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{m.name}</span>
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">{KIND_LABELS[m.def.kind]}</span>
                    {settings.defaultMethodId === m.id && <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-700">default</span>}
                  </div>
                  <div className="text-xs text-slate-500">{describeMethod(m.def)}</div>
                  {m.description && <div className="text-xs text-slate-400">{m.description}</div>}
                  {m.usedBy.length > 0 && <div className="mt-0.5 text-[11px] text-slate-400">Used by {m.usedBy.join(', ')}</div>}
                </div>
                <button className="btn btn-sm" onClick={() => setEditing(m)}>
                  Edit
                </button>
              </li>
            ))}
          </ul>
          {editing && (
            <MethodEditor
              key={editing === 'new' ? 'new' : editing.id}
              method={editing === 'new' ? null : editing}
              practicalExpedient={settings.practicalExpedient}
              onClose={() => setEditing(null)}
              onSaved={async () => {
                setEditing(null);
                await refresh();
              }}
              onError={setError}
            />
          )}
        </section>

        <section className="space-y-3">
          <div>
            <h2 className="text-base font-semibold">Chart of accounts</h2>
            <p className="text-xs text-slate-500">Accounts the monthly journals post to. Match your ERP's numbers so the export imports cleanly. Amortization types can override the expense accounts.</p>
          </div>
          <table className="w-full rounded-lg border border-slate-200 bg-panel text-xs">
            <thead className="text-left text-slate-400">
              <tr className="border-b border-slate-200">
                <th className="px-3 py-1.5 font-normal">Used for</th>
                <th className="px-3 py-1.5 font-normal">Number</th>
                <th className="px-3 py-1.5 font-normal">Account name</th>
              </tr>
            </thead>
            <tbody>
              {ACCOUNT_ROWS.map((r) => (
                <tr key={r.key} className="border-b border-slate-100">
                  <td className="px-3 py-1.5">
                    <div className="font-medium text-slate-700">{r.label}</div>
                    <div className="text-[11px] text-slate-400">{r.hint}</div>
                  </td>
                  <td className="px-3 py-1.5">
                    <input className="input w-24 font-mono" value={settings.accounts[r.key].number} onChange={(e) => setAcct(r.key, 'number', e.target.value)} />
                  </td>
                  <td className="px-3 py-1.5">
                    <input className="input w-full" value={settings.accounts[r.key].name} onChange={(e) => setAcct(r.key, 'name', e.target.value)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}

function MethodEditor({
  method,
  practicalExpedient,
  onClose,
  onSaved,
  onError,
}: {
  method: AmortizationMethodRow | null;
  practicalExpedient: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onError: (m: string) => void;
}) {
  const [name, setName] = useState(method?.name ?? '');
  const [description, setDescription] = useState(method?.description ?? '');
  const [def, setDef] = useState<AmortizationMethodDef>(method?.def ?? blankDef());
  const [monthText, setMonthText] = useState((method?.def.monthPercents ?? []).join(', '));
  const [sample, setSample] = useState({ amount: 12_000, payMonth: '2026-02', contractStart: '2026-02-01', termMonths: 36 });
  const [preview, setPreview] = useState<{ errors: string[]; schedule: MethodSchedule | null } | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      api
        .previewMethod({ def, amount: sample.amount, payMonth: sample.payMonth, contractStart: sample.contractStart || null, termMonths: sample.termMonths || null, practicalExpedient })
        .then(setPreview)
        .catch((e) => setPreview({ errors: [e.message], schedule: null }));
    }, 250);
    return () => clearTimeout(t);
  }, [def, sample, practicalExpedient]);

  const yearly = useMemo(() => {
    const s = preview?.schedule;
    if (!s) return [];
    const by = new Map<string, number>();
    for (const [m, v] of Object.entries(s.byMonth)) by.set(m.slice(0, 4), (by.get(m.slice(0, 4)) ?? 0) + v);
    return [...by.entries()].sort();
  }, [preview]);

  const pctSum = (a: number[]) => Math.round(a.reduce((x, y) => x + y, 0) * 1000) / 1000;
  const save = async () => {
    try {
      const body = { name: name.trim(), description: description.trim() || null, def };
      if (method) await api.updateMethod(method.id, body);
      else await api.createMethod(body);
      await onSaved();
    } catch (e) {
      onError((e as Error).message);
    }
  };
  const remove = async () => {
    if (!method || !window.confirm(`Delete "${method.name}"? Types using it fall back to the company default.`)) return;
    try {
      await api.deleteMethod(method.id);
      await onSaved();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  return (
    <div className="space-y-4 rounded-lg border border-indigo-200 bg-panel p-4 text-xs">
      <div className="flex items-center gap-2">
        <div className="text-sm font-semibold">{method ? `Edit ${method.name}` : 'New amortization method'}</div>
        <div className="flex-1" />
        {method && (
          <button className="btn btn-sm text-rose-600" onClick={remove}>
            Delete
          </button>
        )}
        <button className="btn btn-sm" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-sm btn-primary" disabled={!name.trim() || !!preview?.errors.length} onClick={save}>
          Save method
        </button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <label className="text-slate-600">
          Name
          <input className="input mt-1 block w-full" placeholder="Ramped 3-year 20/30/50" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="text-slate-600">
          Description
          <input className="input mt-1 block w-full" placeholder="When to use it" value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
      </div>

      <div className="flex flex-wrap gap-2">
        {(Object.keys(KIND_LABELS) as AmortizationMethodDef['kind'][]).map((k) => (
          <button key={k} className={`btn btn-sm ${def.kind === k ? 'btn-primary' : ''}`} onClick={() => setDef({ ...def, kind: k, yearPercents: k === 'yearly_percent' && !def.yearPercents.length ? [100] : def.yearPercents })}>
            {KIND_LABELS[k]}
          </button>
        ))}
      </div>

      {def.kind !== 'immediate' && (
        <div className="grid grid-cols-2 gap-3">
          <label className="text-slate-600">
            Amortization starts
            <select className="select mt-1 block w-full" value={def.startBasis} onChange={(e) => setDef({ ...def, startBasis: e.target.value as AmortizationMethodDef['startBasis'] })}>
              <option value="contract_start">With the subscription start (falls back to pay month)</option>
              <option value="pay_month">In the pay month</option>
              <option value="month_after_pay">The month after the pay month</option>
            </select>
          </label>
          {def.kind === 'straight_line' && (
            <div className="text-slate-600">
              Over
              <div className="mt-1 flex items-center gap-2">
                <select className="select" value={def.periodBasis} onChange={(e) => setDef({ ...def, periodBasis: e.target.value as AmortizationMethodDef['periodBasis'] })}>
                  <option value="contract_term">the contract term ×</option>
                  <option value="fixed_months">a fixed number of months</option>
                </select>
                {def.periodBasis === 'contract_term' ? (
                  <input type="number" step={0.25} min={0.25} className="input w-20" value={def.termMultiplier} onChange={(e) => setDef({ ...def, termMultiplier: Number(e.target.value) || 1 })} />
                ) : (
                  <input type="number" min={1} className="input w-20" value={def.months ?? ''} onChange={(e) => setDef({ ...def, months: Number(e.target.value) || null })} />
                )}
                <span className="text-slate-400">{def.periodBasis === 'contract_term' ? '(1 = term only; 1.5 adds an expected renewal half)' : 'months (e.g. 48 for a 4-year customer life)'}</span>
              </div>
            </div>
          )}
        </div>
      )}

      {def.kind === 'yearly_percent' && (
        <div className="space-y-1 text-slate-600">
          <div>Percent of the commission recognized in each contract year (spread evenly over that year's 12 months):</div>
          <div className="flex flex-wrap items-center gap-2">
            {def.yearPercents.map((p, i) => (
              <label key={i} className="flex items-center gap-1">
                Y{i + 1}
                <input
                  type="number"
                  min={0}
                  max={100}
                  className="input w-16"
                  value={p}
                  onChange={(e) => setDef({ ...def, yearPercents: def.yearPercents.map((x, j) => (j === i ? Number(e.target.value) || 0 : x)) })}
                />
                %
              </label>
            ))}
            <button className="btn btn-sm" onClick={() => setDef({ ...def, yearPercents: [...def.yearPercents, 0] })}>
              + Year
            </button>
            {def.yearPercents.length > 1 && (
              <button className="btn btn-sm" onClick={() => setDef({ ...def, yearPercents: def.yearPercents.slice(0, -1) })}>
                − Year
              </button>
            )}
            <span className={pctSum(def.yearPercents) === 100 ? 'text-emerald-700' : 'text-amber-700'}>Total {pctSum(def.yearPercents)}%</span>
          </div>
        </div>
      )}

      {def.kind === 'monthly_percent' && (
        <label className="block text-slate-600">
          Percent per month, comma-separated (first month first). Must total 100%.
          <textarea
            className="input mt-1 block h-16 w-full font-mono"
            value={monthText}
            placeholder="10, 10, 10, 5, 5, 5, ..."
            onChange={(e) => {
              setMonthText(e.target.value);
              setDef({ ...def, monthPercents: e.target.value.split(/[,\s]+/).filter(Boolean).map(Number).filter((n) => Number.isFinite(n)) });
            }}
          />
          <span className={pctSum(def.monthPercents) === 100 ? 'text-emerald-700' : 'text-amber-700'}>
            {def.monthPercents.length} months · total {pctSum(def.monthPercents)}%
          </span>
        </label>
      )}

      <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
        <div className="mb-2 flex flex-wrap items-center gap-2 text-slate-600">
          <span className="font-semibold">Preview</span>
          <label className="flex items-center gap-1">
            commission
            <input type="number" className="input w-24" value={sample.amount} onChange={(e) => setSample({ ...sample, amount: Number(e.target.value) || 0 })} />
          </label>
          <label className="flex items-center gap-1">
            pay month
            <input type="month" className="input" value={sample.payMonth} onChange={(e) => setSample({ ...sample, payMonth: e.target.value })} />
          </label>
          <label className="flex items-center gap-1">
            subscription start
            <input type="date" className="input" value={sample.contractStart} onChange={(e) => setSample({ ...sample, contractStart: e.target.value })} />
          </label>
          <label className="flex items-center gap-1">
            term
            <input type="number" className="input w-16" value={sample.termMonths} onChange={(e) => setSample({ ...sample, termMonths: Number(e.target.value) || 0 })} />
            mo
          </label>
        </div>
        {preview?.errors.length ? (
          <div className="text-amber-700">{preview.errors.join(' ')}</div>
        ) : preview?.schedule ? (
          preview.schedule.capitalize ? (
            <div className="space-y-2">
              <Bars data={Object.entries(preview.schedule.byMonth).map(([m, v]) => ({ label: monthLabel(m), value: v }))} />
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-slate-500">
                <span>
                  {monthLabel(preview.schedule.startMonth)} for {preview.schedule.months} months
                </span>
                {yearly.map(([y, v]) => (
                  <span key={y}>
                    {y}: <span className="text-slate-700">{money(Math.round(v * 100) / 100)}</span>
                  </span>
                ))}
              </div>
            </div>
          ) : (
            <div className="text-slate-500">
              {preview.schedule.warnings.includes('expedient') ? 'The practical expedient applies (12 months or less): expensed when accrued.' : 'Expensed in full when accrued; nothing is capitalized.'}
            </div>
          )
        ) : (
          <div className="text-slate-400">…</div>
        )}
      </div>
    </div>
  );
}
