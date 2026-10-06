import { emptyTiers, tierPayout, type PlanTiers } from '@commissions/shared';
import { useCallback, useEffect, useState } from 'react';
import { api, type CompPlan, type PlanParams, type ThresholdType } from '../api';
import { PeriodPicker } from './PeriodPicker';

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
              <div className="col-span-2 text-slate-600">
                Effective period <span className="text-slate-400">(assignments to this plan only count inside it)</span>
                <div className="mt-1">
                  <PeriodPicker from={draft.effectiveFrom} to={draft.effectiveTo} onChange={(effectiveFrom, effectiveTo) => setDraft({ ...draft, effectiveFrom, effectiveTo })} />
                </div>
              </div>
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

            <TierEditor
              tiers={draft.tiers}
              paramValue={(key) => parseNum(paramRows.find((r) => r.key.trim() === key)?.value ?? '')}
              onChange={(tiers) => setDraft({ ...draft, tiers })}
            />
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

function TierEditor({ tiers, paramValue, onChange }: { tiers: PlanTiers; paramValue: (key: string) => number | null; onChange: (t: PlanTiers) => void }) {
  const [types, setTypes] = useState<ThresholdType[]>([]);
  const [newType, setNewType] = useState<{ name: string; unit: string; scaleParam: string } | null>(null);
  const [typeError, setTypeError] = useState<string | null>(null);
  useEffect(() => {
    api.listThresholdTypes().then(setTypes).catch(() => {});
  }, []);

  const type = types.find((t) => t.key === tiers.basis);
  // Scaling: from the type if loaded, else what the plan already carries.
  const scaleParam = type ? type.scaleParam : (tiers.scaleParam ?? (tiers.basis === 'percent_of_quota' ? 'quota' : null));
  const isPct = !!scaleParam;
  const unit = type?.unit ?? (isPct ? '%' : '$');
  const scale = scaleParam ? paramValue(scaleParam) : null;

  const showFrom = (n: number) => (isPct ? pct(n) : String(n));
  const [rows, setRows] = useState(() => tiers.rows.map((r) => ({ from: showFrom(r.from), rate: pct(r.rate) })));
  // Re-seed the text rows when a different plan is loaded.
  const [seedKey, setSeedKey] = useState(JSON.stringify(tiers));
  const key = JSON.stringify(tiers);
  if (key !== seedKey) {
    const ours = rows.map((r) => ({ from: parseNum(r.from) ?? 0, rate: parseNum(r.rate) ?? 0 }));
    if (JSON.stringify(ours) !== JSON.stringify(tiers.rows)) setRows(tiers.rows.map((r) => ({ from: showFrom(r.from), rate: pct(r.rate) })));
    setSeedKey(key);
  }

  const commit = (next: { from: string; rate: string }[], patch: Partial<PlanTiers> = {}) => {
    setRows(next);
    onChange({ ...tiers, ...patch, rows: next.map((r) => ({ from: parseNum(r.from) ?? 0, rate: parseNum(r.rate) ?? 0 })) });
  };
  const pickType = (k: string) => {
    if (k === '__new') return setNewType({ name: '', unit: '', scaleParam: '' });
    const t = types.find((x) => x.key === k);
    commit(rows, { basis: k, scaleParam: t ? t.scaleParam : null });
  };
  const createType = async () => {
    if (!newType?.name.trim()) return;
    setTypeError(null);
    try {
      const created = await api.createThresholdType({ name: newType.name, unit: newType.unit, scaleParam: newType.scaleParam || null });
      setTypes(await api.listThresholdTypes());
      setNewType(null);
      commit(rows, { basis: created.key, scaleParam: created.scaleParam });
    } catch (e) {
      setTypeError((e as Error).message);
    }
  };

  const sample = isPct ? (scale ?? 0) * 1.2 : unit === '$' ? 120000 : 150;
  const preview = tiers.rows.length ? tierPayout(sample, { ...tiers, scaleParam }, scale) : null;
  const rateIsMoney = unit !== '$' && unit !== '%';

  return (
    <div>
      <div className="mb-1 flex items-center text-xs">
        <span className="font-semibold text-slate-600">Tiers</span>
        <span className="ml-2 text-slate-400">
          used by <code>TIER(x)</code> in Calculate — x is whatever you pass (dollars won, calls made, …)
        </span>
        <div className="flex-1" />
        <button className="btn btn-sm" onClick={() => commit([...rows, { from: rows.length ? '' : '0', rate: '' }])}>
          + Tier
        </button>
      </div>
      <div className="mb-2 flex flex-wrap gap-3 text-xs">
        <label className="text-slate-600">
          Threshold type{' '}
          <select className="select" value={type ? tiers.basis : tiers.basis} onChange={(e) => pickType(e.target.value)}>
            {!type && <option value={tiers.basis}>{tiers.basis}</option>}
            {types.map((t) => (
              <option key={t.key} value={t.key}>
                {t.name}
                {t.scaleParam ? ` (of plan.${t.scaleParam})` : t.unit ? ` (${t.unit})` : ''}
              </option>
            ))}
            <option value="__new">+ New threshold type…</option>
          </select>
        </label>
        <label className="text-slate-600">
          Payout{' '}
          <select className="select" value={tiers.mode} onChange={(e) => commit(rows, { mode: e.target.value as PlanTiers['mode'] })}>
            <option value="marginal">marginal — each tier's rate applies to its own slice</option>
            <option value="whole">whole amount — the highest tier reached re-rates everything</option>
          </select>
        </label>
      </div>
      {newType && (
        <div className="mb-2 flex flex-wrap items-end gap-2 rounded-md border border-indigo-200 bg-indigo-50/50 p-2 text-xs">
          <label className="text-slate-600">
            Name
            <input className="input mt-1 block w-36" autoFocus placeholder="Calls" value={newType.name} onChange={(e) => setNewType({ ...newType, name: e.target.value })} />
          </label>
          <label className="text-slate-600">
            Unit <span className="text-slate-400">(label)</span>
            <input className="input mt-1 block w-24" placeholder="calls" value={newType.unit} onChange={(e) => setNewType({ ...newType, unit: e.target.value })} />
          </label>
          <label className="text-slate-600">
            % of plan parameter <span className="text-slate-400">(optional)</span>
            <input className="input mt-1 block w-28 font-mono" placeholder="e.g. target" value={newType.scaleParam} onChange={(e) => setNewType({ ...newType, scaleParam: e.target.value })} />
          </label>
          <button className="btn btn-sm btn-primary" disabled={!newType.name.trim()} onClick={createType}>
            Create
          </button>
          <button className="btn btn-sm" onClick={() => setNewType(null)}>
            Cancel
          </button>
          {typeError && <span className="text-rose-700">{typeError}</span>}
          <div className="w-full text-slate-500">
            Leave the parameter blank for absolute thresholds (dollars, counts). Fill it in to express thresholds as a percentage of e.g. <code>plan.quota</code> or <code>plan.target</code>.
          </div>
        </div>
      )}
      <div className="space-y-1 text-xs">
        {rows.map((r, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="w-10 text-right text-slate-400">from</span>
            <input className="input w-28" placeholder={isPct ? '80%' : unit === '$' ? '50000' : '100'} value={r.from} onChange={(e) => commit(rows.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)))} />
            <span className="text-slate-400">{unit && !isPct ? unit : ''} pay</span>
            <input className="input w-24" placeholder={rateIsMoney ? '$5 each' : '8%'} value={r.rate} onChange={(e) => commit(rows.map((x, j) => (j === i ? { ...x, rate: e.target.value } : x)))} />
            <span className="text-slate-400">{rateIsMoney ? `per ${unit.replace(/s$/, '')}` : 'of the amount'}</span>
            <div className="flex-1" />
            <button className="text-slate-400 hover:text-rose-600" onClick={() => commit(rows.filter((_, j) => j !== i))}>
              ✕
            </button>
          </div>
        ))}
        {rows.length === 0 && <div className="text-slate-400">No tiers. Example: from 0 pay 5% · from 50,000 pay 10% · from 100,000 pay 15%.</div>}
        {isPct && (scale === null || scale <= 0) && rows.length > 0 && (
          <div className="text-amber-700">
            Add a numeric <code>{scaleParam}</code> parameter above for %-of-{scaleParam} thresholds to work (an employee's own quota overrides it).
          </div>
        )}
        {preview !== null && (
          <div className="text-slate-400">
            Check: {isPct ? `120% of ${scaleParam}` : unit === '$' ? '$120,000' : `150 ${unit}`} would pay <strong className="text-slate-600">{preview.toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong>.
          </div>
        )}
      </div>
    </div>
  );
}

