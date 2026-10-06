import { emptyTiers, tierPayout, type PlanTiers } from '@commissions/shared';
import { useCallback, useEffect, useState } from 'react';
import { api, type CompPlan, type ImportSummary, type PlanParams, type RepAssignment } from '../api';

type Draft = Omit<CompPlan, 'id' | 'updatedAt' | 'repCount'>;

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
  const [assignments, setAssignments] = useState<RepAssignment[]>([]);
  const [selectedId, setSelectedId] = useState<string | 'new' | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [paramRows, setParamRows] = useState<{ key: string; value: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    const [p, a] = await Promise.all([api.listPlans(), api.listAssignments()]);
    setPlans(p);
    setAssignments(a);
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
    if (!p || !window.confirm(`Delete plan "${p.name}" and its ${p.repCount ?? 0} rep assignment(s)?`)) return;
    await api.deletePlan(selectedId);
    const list = await refresh();
    if (list.length) select(list[0]);
    else select('new');
  };

  const planAssignments = assignments.filter((a) => a.compPlanId === selectedId);

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
                {p.repCount ?? 0} rep{p.repCount === 1 ? '' : 's'} · {Object.keys(p.params).length} param{Object.keys(p.params).length === 1 ? '' : 's'}
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
            <AssignmentsSection planId={selectedId} planName={draft.name} assignments={planAssignments} plans={plans} onChanged={refresh} onError={setError} />
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

// -- Rep assignments ---------------------------------------------------------

interface AssignProps {
  planId: string;
  planName: string;
  assignments: RepAssignment[];
  plans: CompPlan[];
  onChanged: () => Promise<unknown>;
  onError: (m: string) => void;
}

function AssignmentsSection({ planId, planName, assignments, plans, onChanged, onError }: AssignProps) {
  const [names, setNames] = useState('');
  const [imports, setImports] = useState<ImportSummary[]>([]);
  const [pickImport, setPickImport] = useState('');
  const [pickColumn, setPickColumn] = useState('');
  const [columns, setColumns] = useState<string[]>([]);
  const [candidates, setCandidates] = useState<{ value: string; count: number }[]>([]);
  const [ticked, setTicked] = useState<Set<string>>(new Set());

  useEffect(() => {
    api.listImports().then(setImports).catch(() => {});
  }, []);
  useEffect(() => {
    if (!pickImport) return;
    api.getImport(pickImport).then((imp) => {
      const names = imp.columns.map((c) => c.name);
      setColumns(names);
      const guess = names.find((n) => /rep|owner|sales|employee|name/i.test(n)) ?? names[0] ?? '';
      setPickColumn(guess);
    });
  }, [pickImport]);
  useEffect(() => {
    if (!pickImport || !pickColumn) return;
    api.values(pickImport, { field: pickColumn, limit: 500 }).then((r) => {
      setCandidates(r.values.filter((v) => v.value !== ''));
      setTicked(new Set());
    });
  }, [pickImport, pickColumn]);

  const assigned = new Set(assignments.map((a) => a.repName.toLowerCase()));

  const addTyped = async () => {
    const list = names
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!list.length) return;
    try {
      await api.bulkAssign({ compPlanId: planId, repNames: list });
      setNames('');
      await onChanged();
    } catch (e) {
      onError((e as Error).message);
    }
  };
  const addTicked = async () => {
    if (!ticked.size) return;
    try {
      await api.bulkAssign({ compPlanId: planId, repNames: [...ticked] });
      setTicked(new Set());
      await onChanged();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold">
        Reps on {planName || 'this plan'} <span className="font-normal text-slate-400">({assignments.length})</span>
      </h3>
      <p className="text-xs text-slate-500">
        Names must match the rep column in your data (case-insensitive). Effective dates are optional; leave blank for always.
      </p>

      <table className="w-full text-xs">
        <tbody>
          {assignments.map((a) => (
            <tr key={a.id} className="border-b border-slate-100">
              <td className="py-1 font-medium">{a.repName}</td>
              <td className="py-1 text-slate-500">
                <input
                  type="date"
                  className="input"
                  value={a.effectiveFrom ?? ''}
                  onChange={(e) => api.updateAssignment(a.id, { ...a, effectiveFrom: e.target.value || null }).then(onChanged)}
                />
                <span className="mx-1">→</span>
                <input
                  type="date"
                  className="input"
                  value={a.effectiveTo ?? ''}
                  onChange={(e) => api.updateAssignment(a.id, { ...a, effectiveTo: e.target.value || null }).then(onChanged)}
                />
              </td>
              <td className="py-1">
                <select className="select" value={a.compPlanId} onChange={(e) => api.updateAssignment(a.id, { ...a, compPlanId: e.target.value }).then(onChanged)}>
                  {plans.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </td>
              <td className="py-1 text-right">
                <button className="text-slate-400 hover:text-rose-600" onClick={() => api.deleteAssignment(a.id).then(onChanged)}>
                  ✕
                </button>
              </td>
            </tr>
          ))}
          {assignments.length === 0 && (
            <tr>
              <td className="py-2 text-slate-400">No reps assigned yet.</td>
            </tr>
          )}
        </tbody>
      </table>

      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-lg border border-slate-200 bg-white p-3 text-xs">
          <div className="mb-1 font-semibold text-slate-600">Add reps by name</div>
          <textarea className="input block h-20 w-full" placeholder={'One per line, or comma-separated'} value={names} onChange={(e) => setNames(e.target.value)} />
          <button className="btn btn-sm mt-2" onClick={addTyped} disabled={!names.trim()}>
            Add
          </button>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-3 text-xs">
          <div className="mb-1 font-semibold text-slate-600">Pick reps from an import</div>
          <div className="flex gap-1">
            <select className="select flex-1" value={pickImport} onChange={(e) => setPickImport(e.target.value)}>
              <option value="">— import —</option>
              {imports.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
            <select className="select flex-1" value={pickColumn} onChange={(e) => setPickColumn(e.target.value)} disabled={!pickImport}>
              {columns.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div className="mt-2 max-h-40 overflow-auto">
            {candidates.map((c) => {
              const done = assigned.has(c.value.toLowerCase());
              return (
                <label key={c.value} className={`flex items-center gap-2 py-0.5 ${done ? 'text-slate-400' : ''}`}>
                  <input
                    type="checkbox"
                    disabled={done}
                    checked={done || ticked.has(c.value)}
                    onChange={() =>
                      setTicked((t) => {
                        const n = new Set(t);
                        if (n.has(c.value)) n.delete(c.value);
                        else n.add(c.value);
                        return n;
                      })
                    }
                  />
                  <span className="flex-1 truncate">{c.value}</span>
                  <span className="text-slate-400">{done ? 'assigned' : c.count}</span>
                </label>
              );
            })}
          </div>
          <button className="btn btn-sm mt-2" onClick={addTicked} disabled={!ticked.size}>
            Add {ticked.size || ''} selected
          </button>
        </div>
      </div>
    </section>
  );
}
