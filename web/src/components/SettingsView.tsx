import { useEffect, useState } from 'react';
import { api, type HoldReason } from '../api';
import { CompPlansView } from './CompPlansView';
import { UsersSettings } from './UsersSettings';

export type SettingsTab = 'plans' | 'hold-reasons' | 'users';

export function SettingsView({ tab }: { tab: SettingsTab }) {
  if (tab === 'plans') return <CompPlansView />;
  if (tab === 'users') return <UsersSettings />;
  return (
    <div className="mx-auto w-full max-w-3xl space-y-8 p-6">
      <HoldReasonsSettings />
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
