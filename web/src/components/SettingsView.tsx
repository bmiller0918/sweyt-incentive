import { useEffect, useState } from 'react';
import { api, type AccountingPolicyRow, type HoldReason } from '../api';
import { CompPlansView } from './CompPlansView';

export type SettingsTab = 'plans' | 'hold-reasons' | 'accounting';

export function SettingsView({ tab }: { tab: SettingsTab }) {
  if (tab === 'plans') return <CompPlansView />;
  return (
    <div className="mx-auto w-full max-w-3xl space-y-8 p-6">
      {tab === 'hold-reasons' ? <HoldReasonsSettings /> : <AccountingPolicySettings />}
    </div>
  );
}

function HoldReasonsSettings() {
  const [reasons, setReasons] = useState<HoldReason[]>([]);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const refresh = () => api.listHoldReasons().then(setReasons).catch((e) => setError(e.message));
  useEffect(() => {
    refresh();
  }, []);
  const add = async () => {
    if (!name.trim()) return;
    try {
      await api.createHoldReason(name.trim());
      setName('');
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-base font-semibold">Hold reasons</h2>
        <p className="text-xs text-slate-500">Why a commission line is on hold. Hold rules on a run pick from this list; built-ins can't be removed.</p>
      </div>
      {error && <div className="rounded bg-rose-50 px-2 py-1 text-xs text-rose-700">{error}</div>}
      <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-panel text-sm">
        {reasons.map((r) => (
          <li key={r.id} className="flex items-center gap-2 px-3 py-2">
            <span className="flex-1">{r.name}</span>
            <span className="font-mono text-[11px] text-slate-400">{r.key}</span>
            {r.builtin ? (
              <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">built-in</span>
            ) : (
              <button className="text-slate-400 hover:text-rose-600" onClick={() => api.deleteHoldReason(r.id).then(refresh).catch((e) => setError(e.message))}>
                ✕
              </button>
            )}
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <input className="input flex-1" placeholder="New reason, e.g. Pending legal review" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
        <button className="btn btn-primary" disabled={!name.trim()} onClick={add}>
          Add
        </button>
      </div>
    </section>
  );
}

function AccountingPolicySettings() {
  const [policy, setPolicy] = useState<AccountingPolicyRow | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.getAccountingPolicy().then(setPolicy).catch((e) => setError(e.message));
  }, []);
  const save = async () => {
    if (!policy) return;
    try {
      setPolicy(await api.updateAccountingPolicy({ method: policy.method, customerLifeMonths: policy.customerLifeMonths, defaultTermMonths: policy.defaultTermMonths }));
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  if (!policy) return <div className="text-sm text-slate-400">{error ?? 'Loading…'}</div>;
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-base font-semibold">Accounting policy</h2>
        <p className="text-xs text-slate-500">How capitalized commissions are amortized. Applies to every run's Accounting tab.</p>
      </div>
      {error && <div className="rounded bg-rose-50 px-2 py-1 text-xs text-rose-700">{error}</div>}
      <div className="space-y-3 rounded-lg border border-slate-200 bg-panel p-4 text-sm">
        <label className="block text-xs text-slate-600">
          Amortization method
          <select className="select mt-1 block" value={policy.method} onChange={(e) => setPolicy({ ...policy, method: e.target.value as AccountingPolicyRow['method'] })}>
            <option value="contract_term">Over the contract term (from subscription start)</option>
            <option value="customer_life">Over an estimated customer life (practical expedient)</option>
          </select>
        </label>
        {policy.method === 'customer_life' ? (
          <label className="block text-xs text-slate-600">
            Customer life (months)
            <input type="number" min={1} max={240} className="input mt-1 block w-28" value={policy.customerLifeMonths} onChange={(e) => setPolicy({ ...policy, customerLifeMonths: Number(e.target.value) || 1 })} />
          </label>
        ) : (
          <label className="block text-xs text-slate-600">
            Default term when a deal has none (months)
            <input type="number" min={1} max={240} className="input mt-1 block w-28" value={policy.defaultTermMonths} onChange={(e) => setPolicy({ ...policy, defaultTermMonths: Number(e.target.value) || 1 })} />
          </label>
        )}
        <div className="flex items-center gap-2">
          <button className="btn btn-primary" onClick={save}>
            Save policy
          </button>
          {saved && <span className="text-xs text-emerald-700">Saved</span>}
        </div>
      </div>
    </section>
  );
}
