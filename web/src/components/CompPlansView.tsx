import { emptyTiers, tierPayout, type PlanTiers } from '@commissions/shared';
import { useCallback, useEffect, useState } from 'react';
import { api, type CompPlan, type PlanParams } from '../api';

type Draft = Omit<CompPlan, 'id' | 'updatedAt' | 'employeeCount'>;

const emptyDraft = (): Draft => ({ name: '', description: '', params: { rate: 0.1, quota: 100000 }, tiers: emptyTiers(), effectiveFrom: null, effectiveTo: null });

/** "8%" -> 0.08, "0.08" -> 0.08, "$50,000" -> 50000. */
function parseNum(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  if (/%$/.test(t)) {
    const n = Number(t.slice(0, -1).replace(/,/g, ''));
    return Number.isFinite(n) ? n / 100 : null;
  }
  const n = Number(t.replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}
const pct = (n: number) => `${Math.round(n * 10000) / 100}%`;

function parseParam(s: string): PlanParams[string] {
  const t = s.trim();
  if (t === '') return null;
  if (/^(true|false)$/i.test(t)) return t.toLowerCase() === 'true';
  if (/^-?\d+(\.\d+)?%$/.test(t)) return Number(t.slice(0, -1)) / 100;
  const n = Number(t.replace(/[$,]/g, ''));
  return Number.isFinite(n) && /^[-$\d.,]+$/.test(t) ? n : t;
}

export function CompPlansView() {
  const [plans, setPlans] = useState<CompPlan[]>([]);
  const [selectedId, setSelectedId] = useState<string | 'new' | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [paramRows, setParamRows] = useState<{ key: string; value: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    const p = await api.listPlans();
    setPlans(p);
    return p;
  }, []);

  useEffect(() => {
    refresh()
      .then((p) => {
        if (p.length && !selectedId) select(p[0]);
        else if (!p.length) select('new');
      })
      .catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const select = (p: CompPlan | 'new') => {
    if (p === 'new') {
      setSelectedId('new');
      const d = emptyDraft();
      setDraft(d);
      setParamRows(Object.entries(d.params).map(([key, value]) => ({ key, value: String(value ?? '') })));
      return;
    }
    setSelectedId(p.id);
    setDraft({ name: p.name, description: p.description ?? '', params: p.params, tiers: p.tiers ?? emptyTiers(), effectiveFrom: p.effectiveFrom, effectiveTo: p.effectiveTo });
    setParamRows(Object.entries(p.params).map(([key, value]) => ({ key, value: String(value ?? '') })));
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const params: PlanParams = {};
      for (const r of paramRows) if (r.key.trim()) params[r.key.trim().replace(/\s+/g, '_')] = parseParam(r.value);
      const body: Draft = { ...draft, description: draft.description || null, params };
      const saved = selectedId === 'new' || !selectedId ? await api.createPlan(body) : await api.updatePlan(selectedId, body);
      await refresh();
      select(saved);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!selectedId || selectedId === 'new') return;
    const p = plans.find((x) => x.id === selectedId);
    if (!p || !window.confirm(`Delete plan "${p.name}"? ${p.employeeCount ?? 0} employee(s) are assigned to it.`)) return;
    await api.deletePlan(selectedId);
    const list = await refresh();
    if (list.length) select(list[0]);
    else select('new');
  };

  return (
    <div className="flex h-full">
      <aside className="flex w-64 shrink-0 flex-col border-r border-slate-200 bg-white">
        <div className="flex items-center border-b border-slate-200 px-3 py-2">
          <span className="text-sm font-semibold">Comp plans</span>
          <div className="flex-1" />
          <button className="btn btn-sm btn-primary" onClick={() => select('new')}>
            + New
          </button>
        </div>
        <div className="flex-1 overflow-auto p-2">
          {plans.map((p) => (
            <button
              key={p.id}
              onClick={() => select(p)}
              className={`block w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-slate-100 ${selectedId === p.id ? 'bg-indigo-50 text-indigo-700' : 'text-slate-700'}`}
            >
              <div className="truncate font-medium">{p.name}</div>
              <div className="text-xs text-slate-400">
                {p.employeeCount ?? 0} employee{p.employeeCount === 1 ? '' : 's'} · {Object.keys(p.params).length} param{Object.keys(p.params).length === 1 ? '' : 's'}
                {p.tiers?.rows.length ? ` · ${p.tiers.rows.length} tiers` : ''}
              </div>
            </button>
          ))}
          {plans.length === 0 && <div className="px-2 py-4 text-xs text-slate-400">No plans yet.</div>}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col overflow-auto">
        {error && (
          <div className="border-b border-red-200 bg-red-50 px-4 py-1.5 text-xs text-red-700">
            {error}{' '}
            <button className="underline" onClick={() => setError(null)}>
              dismiss
            </button>
          </div>
        )}
        <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold">{selectedId === 'new' ? 'New plan' : 'Plan'}</h2>
              <div className="flex-1" />
              {selectedId !== 'new' && (
                <button className="btn text-rose-600" onClick={remove}>
                  Delete
                </button>
              )}
              <button className="btn btn-primary" disabled={saving || !draft.name.trim()} onClick={save}>
                {saving ? 'Saving…' : 'Save plan'}
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <label className="col-span-2 text-slate-600">
                Name
                <input className="input mt-1 block w-full" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Enterprise AE 2026" />
              </label>
              <label className="col-span-2 text-slate-600">
                Description
                <input className="input mt-1 block w-full" value={draft.description ?? ''} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
              </label>
              <label className="text-slate-600">
                Effective from
                <input type="date" className="input mt-1 block w-full" value={draft.effectiveFrom ?? ''} onChange={(e) => setDraft({ ...draft, effectiveFrom: e.target.value || null })} />
              </label>
              <label className="text-slate-600">
                Effective to
                <input type="date" className="input mt-1 block w-full" value={draft.effectiveTo ?? ''} onChange={(e) => setDraft({ ...draft, effectiveTo: e.target.value || null })} />
              </label>
            </div>

            <div>
              <div className="mb-1 flex items-center text-xs">
                <span className="font-semibold text-slate-600">Parameters</span>
                <span className="ml-2 text-slate-400">
                  used in formulas as <code>plan.name</code> — e.g. <code>[Sum of Amount] * plan.rate</code>
                </span>
                <div className="flex-1" />
                <button className="btn btn-sm" onClick={() => setParamRows([...paramRows, { key: '', value: '' }])}>
                  + Parameter
                </button>
              </div>
              <div className="space-y-1">
                {paramRows.map((r, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <span className="text-slate-400">plan.</span>
                    <input
                      className="input w-40 font-mono"
                      placeholder="rate"
                      value={r.key}
                      onChange={(e) => setParamRows(paramRows.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))}
                    />
                    <span className="text-slate-400">=</span>
                    <input
                      className="input w-40"
                      placeholder="0.12 or 12%"
                      value={r.value}
                      onChange={(e) => setParamRows(paramRows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                    />
                    <span className="text-slate-400">→ {JSON.stringify(parseParam(r.value))}</span>
                    <div className="flex-1" />
                    <button className="text-slate-400 hover:text-rose-600" onClick={() => setParamRows(paramRows.filter((_, j) => j !== i))}>
                      ✕
                    </button>
                  </div>
                ))}
                {paramRows.length === 0 && <div className="text-xs text-slate-400">No parameters. Add e.g. rate = 12%, quota = 100000.</div>}
              </div>
            </div>

            <TierEditor tiers={draft.tiers} quota={typeof draft.params.quota === 'number' ? draft.params.quota : parseNum(paramRows.find((r) => r.key.trim() === 'quota')?.value ?? '')} onChange={(tiers) => setDraft({ ...draft, tiers })} />
          </section>

          {selectedId && selectedId !== 'new' && (
            <p className="text-xs text-slate-500">
              {plans.find((p) => p.id === selectedId)?.employeeCount ?? 0} employee(s) are on this plan. Assign plans to people under <strong>Employees</strong>.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// -- Tiers -------------------------------------------------------------------

function TierEditor({ tiers, quota, onChange }: { tiers: PlanTiers; quota: number | null; onChange: (t: PlanTiers) => void }) {
  const [rows, setRows] = useState(() => tiers.rows.map((r) => ({ from: tiers.basis === 'percent_of_quota' ? pct(r.from) : String(r.from), rate: pct(r.rate) })));
  // Re-seed the text rows when a different plan is loaded.
  const [seedKey, setSeedKey] = useState(JSON.stringify(tiers));
  const key = JSON.stringify(tiers);
  if (key !== seedKey) {
    const fromRows = tiers.rows.map((r) => ({ from: tiers.basis === 'percent_of_quota' ? pct(r.from) : String(r.from), rate: pct(r.rate) }));
    // Only reseed if the structure actually differs from what our text rows represent.
    const ours = rows.map((r) => ({ from: parseNum(r.from) ?? 0, rate: parseNum(r.rate) ?? 0 }));
    if (JSON.stringify(ours) !== JSON.stringify(tiers.rows)) setRows(fromRows);
    setSeedKey(key);
  }

  const commit = (next: { from: string; rate: string }[], patch: Partial<PlanTiers> = {}) => {
    setRows(next);
    onChange({
      ...tiers,
      ...patch,
      rows: next.map((r) => ({ from: parseNum(r.from) ?? 0, rate: parseNum(r.rate) ?? 0 })),
    });
  };
  const isPct = tiers.basis === 'percent_of_quota';
  const sample = isPct ? (quota ?? 0) * 1.2 : 120000;
  const preview = tiers.rows.length ? tierPayout(sample, tiers, quota) : null;

  return (
    <div>
      <div className="mb-1 flex items-center text-xs">
        <span className="font-semibold text-slate-600">Tiers</span>
        <span className="ml-2 text-slate-400">
          used by <code>TIER([amount])</code> in Calculate
        </span>
        <div className="flex-1" />
        <button className="btn btn-sm" onClick={() => commit([...rows, { from: rows.length ? '' : '0', rate: '' }])}>
          + Tier
        </button>
      </div>
      <div className="mb-2 flex flex-wrap gap-3 text-xs">
        <label className="text-slate-600">
          Thresholds in{' '}
          <select className="select" value={tiers.basis} onChange={(e) => commit(rows, { basis: e.target.value as PlanTiers['basis'] })}>
            <option value="amount">dollars</option>
            <option value="percent_of_quota">% of quota (plan.quota)</option>
          </select>
        </label>
        <label className="text-slate-600">
          Mode{' '}
          <select className="select" value={tiers.mode} onChange={(e) => commit(rows, { mode: e.target.value as PlanTiers['mode'] })}>
            <option value="marginal">marginal — each tier rate applies to its slice</option>
            <option value="whole">whole amount — highest tier reached re-rates everything</option>
          </select>
        </label>
      </div>
      <div className="space-y-1 text-xs">
        {rows.map((r, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="w-10 text-right text-slate-400">from</span>
            <input className="input w-28" placeholder={isPct ? '80%' : '50000'} value={r.from} onChange={(e) => commit(rows.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)))} />
            <span className="text-slate-400">pay</span>
            <input className="input w-20" placeholder="8%" value={r.rate} onChange={(e) => commit(rows.map((x, j) => (j === i ? { ...x, rate: e.target.value } : x)))} />
            <div className="flex-1" />
            <button className="text-slate-400 hover:text-rose-600" onClick={() => commit(rows.filter((_, j) => j !== i))}>
              ✕
            </button>
          </div>
        ))}
        {rows.length === 0 && <div className="text-slate-400">No tiers. Example: from 0 pay 5% · from 50,000 pay 10% · from 100,000 pay 15%.</div>}
        {isPct && (quota === null || quota <= 0) && rows.length > 0 && <div className="text-amber-700">Add a numeric <code>quota</code> parameter for %-of-quota thresholds to work.</div>}
        {preview !== null && (
          <div className="text-slate-400">
            Check: {isPct ? '120% of quota' : '$120,000'} would pay <strong className="text-slate-600">{preview.toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong>.
          </div>
        )}
      </div>
    </div>
  );
}

