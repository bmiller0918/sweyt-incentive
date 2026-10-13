import type { AccountMap } from '@commissions/shared';
import { useEffect, useState } from 'react';
import { api, type AccountingSettingsRow, type AmortizationMethodRow } from '../../api';
import { KIND_LABELS, describeMethod } from './AmortizationMethodsView';
import { ErrorBar, PageHeader } from './ui';

const ACCOUNT_ROWS: { key: keyof AccountMap; label: string; hint: string }[] = [
  { key: 'deferredNoncurrent', label: 'Deferred commissions, non-current', hint: 'Asset. New capitalized commissions are debited here.' },
  { key: 'deferredCurrent', label: 'Deferred commissions, current', hint: 'Asset. The part amortizing in the next 12 months, kept right by the reclass.' },
  { key: 'commissionExpense', label: 'Commission expense', hint: 'Expensed commissions (SDRs, practical expedient).' },
  { key: 'amortizationExpense', label: 'Amortization expense', hint: 'Monthly amortization of the asset, by department.' },
  { key: 'impairmentExpense', label: 'Impairment / write-off expense', hint: 'Remaining balance written off on churn or early termination.' },
  { key: 'accruedCommissions', label: 'Accrued commissions', hint: 'Liability credited for everything approved for payroll.' },
];

export function AccountingSettingsView({ onOpenMethods }: { onOpenMethods?: () => void }) {
  const [settings, setSettings] = useState<AccountingSettingsRow | null>(null);
  const [methods, setMethods] = useState<AmortizationMethodRow[]>([]);
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
              <p className="text-xs text-slate-500">How one capitalized commission spreads over months. Each method has its own page with its conventions, formula and a preview.</p>
            </div>
            <div className="flex-1" />
            {onOpenMethods && (
              <button className="btn" onClick={onOpenMethods}>
                Open Amortization Methods
              </button>
            )}
          </div>
          <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-panel text-sm">
            {methods.map((m) => (
              <li key={m.id} className="flex items-center gap-2 px-3 py-2">
                <span className="font-medium">{m.name}</span>
                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">{KIND_LABELS[m.def.kind]}</span>
                {settings.defaultMethodId === m.id && <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-700">default</span>}
                <span className="truncate text-xs text-slate-500">{describeMethod(m.def)}</span>
              </li>
            ))}
          </ul>
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
