import {
  QUOTA_SECTIONS,
  emptyQuotas,
  emptyStructure,
  emptyTiers,
  quotasFromLegacy,
  sectionTiers,
  tierPayout,
  tierRate,
  type PlanQuotas,
  type QuotaSection,
  type QuotaSectionKey,
} from '@commissions/shared';
import { useCallback, useEffect, useState } from 'react';
import { api, type CompPlan, type EmployeeType } from '../api';
import { PeriodPicker } from './PeriodPicker';

type Draft = Omit<CompPlan, 'id' | 'updatedAt' | 'employeeCount'> & { quotas: PlanQuotas };

const emptyDraft = (): Draft => ({
  name: '',
  description: '',
  employeeTypeId: null,
  params: {},
  tiers: emptyTiers(),
  structure: emptyStructure(),
  quotas: emptyQuotas(),
  effectiveFrom: null,
  effectiveTo: null,
});

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
/** "12%" -> 0.12, and a bare "12" also means 12% (for fields that are always percents). */
function parsePct(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t.replace(/[%,\s]/g, ''));
  return Number.isFinite(n) ? n / 100 : null;
}
const pct = (n: number) => `${Math.round(n * 10000) / 100}%`;
const money = (n: number) => n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

/** "Sales Rep · Dollars quota, Percent of margin" for the plan list. */
function sectionSummary(p: CompPlan): string {
  if (!p.quotas) return 'No quota sections yet';
  const on = QUOTA_SECTIONS.filter((s) => p.quotas?.[s.key].applies).map((s) => s.label);
  return on.length ? on.join(', ') : 'No section applies';
}

export function CompPlansView() {
  const [plans, setPlans] = useState<CompPlan[]>([]);
  const [types, setTypes] = useState<EmployeeType[]>([]);
  const [selectedId, setSelectedId] = useState<string | 'new' | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** Bumped on every selection so the section editors reseed their text, even when the same plan is picked again. */
  const [editorKey, setEditorKey] = useState(0);

  const refresh = useCallback(async () => {
    const p = await api.listPlans();
    setPlans(p);
    return p;
  }, []);

  useEffect(() => {
    api.listEmployeeTypes().then(setTypes).catch(() => {});
    refresh()
      .then((p) => {
        if (p.length && !selectedId) select(p[0]);
        else if (!p.length) select('new');
      })
      .catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const select = (p: CompPlan | 'new') => {
    setEditorKey((k) => k + 1);
    if (p === 'new') {
      setSelectedId('new');
      setDraft(emptyDraft());
      return;
    }
    setSelectedId(p.id);
    setDraft({
      name: p.name,
      description: p.description ?? '',
      employeeTypeId: p.employeeTypeId ?? null,
      params: p.params,
      tiers: p.tiers ?? emptyTiers(),
      structure: p.structure ?? emptyStructure(),
      // Plans saved before sections open with their tier table (or flat rate) in the matching section.
      quotas: p.quotas ?? quotasFromLegacy(p),
      effectiveFrom: p.effectiveFrom,
      effectiveTo: p.effectiveTo,
    });
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      // Sections replace the old single tier table and weighted components.
      const body: Draft = { ...draft, description: draft.description || null, tiers: emptyTiers(), structure: emptyStructure() };
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

  const setSection = (key: QuotaSectionKey, s: QuotaSection) => setDraft((d) => ({ ...d, quotas: { ...d.quotas, [key]: s } }));
  const type = types.find((t) => t.id === draft.employeeTypeId);

  return (
    <div className="flex h-full">
      <aside className="flex w-64 shrink-0 flex-col border-r border-slate-200 bg-panel">
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
                {types.find((t) => t.id === p.employeeTypeId)?.name ?? 'No employee type'} · {p.employeeCount ?? 0} employee{p.employeeCount === 1 ? '' : 's'}
              </div>
              <div className="truncate text-[11px] text-slate-400">{sectionSummary(p)}</div>
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
                Employee type
                <select className="select mt-1 block w-full" value={draft.employeeTypeId ?? ''} onChange={(e) => setDraft({ ...draft, employeeTypeId: e.target.value || null })}>
                  <option value="">None</option>
                  {types.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
                <span className="mt-1 block text-slate-400">
                  {type
                    ? type.amortizationTypeId
                      ? `GL treatment follows ${type.name}'s amortization type (Accounting › Amortization types).`
                      : `${type.name} has no amortization type yet, so its commissions are ${type.costTreatment === 'expense' ? 'expensed' : 'capitalized'} by default.`
                    : 'The role this plan is for. Its amortization type decides whether commissions are capitalized or expensed.'}
                </span>
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
          </section>

          <section className="space-y-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-700">Quotas</h3>
              <p className="text-xs text-slate-400">Each section that applies pays its own commission line on every deal. Mark the rest as not applying.</p>
            </div>
            {QUOTA_SECTIONS.map((s) => (
              <SectionEditor key={`${editorKey}-${s.key}`} sectionKey={s.key} label={s.label} hint={s.hint} section={draft.quotas[s.key]} onChange={(next) => setSection(s.key, next)} />
            ))}
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

// -- Quota sections ------------------------------------------------------------

interface SectionUnits {
  /** How a threshold reads and parses. */
  from: { show: (n: number) => string; parse: (s: string) => number | null; placeholder: string; suffix: string };
  rate: { show: (n: number) => string; parse: (s: string) => number | null; placeholder: string; suffix: string };
  target: { label: string; placeholder: string; hint: string } | null;
  empty: string;
}

const plainNum = (n: number) => String(n);

const UNITS: Record<QuotaSectionKey, SectionUnits> = {
  count: {
    from: { show: plainNum, parse: parseNum, placeholder: '10', suffix: 'units' },
    rate: { show: (n) => `$${n}`, parse: parseNum, placeholder: '$250', suffix: 'per unit' },
    target: { label: 'Quota (units)', placeholder: '40', hint: 'Shown to formulas as plan.count_quota.' },
    empty: 'Example: from 0 pay $100 per unit · from 20 pay $250 per unit.',
  },
  dollars: {
    from: { show: plainNum, parse: parseNum, placeholder: '50000', suffix: '$' },
    rate: { show: pct, parse: parsePct, placeholder: '8%', suffix: 'of the amount' },
    target: { label: 'Quota ($)', placeholder: '1,000,000', hint: 'Shown to formulas as plan.dollars_quota.' },
    empty: 'Example: from 0 pay 5% · from 500,000 pay 8%.',
  },
  percentOfQuota: {
    from: { show: pct, parse: parsePct, placeholder: '100%', suffix: 'of quota' },
    rate: { show: pct, parse: parsePct, placeholder: '10%', suffix: 'of the amount' },
    target: { label: 'Quota ($)', placeholder: '1,000,000', hint: "An employee's own quota (or their type's default) overrides this." },
    empty: 'Example: from 0% pay 5% · from 100% pay 10%.',
  },
  percentOfMargin: {
    from: { show: pct, parse: parsePct, placeholder: '15%', suffix: 'gross margin' },
    rate: { show: pct, parse: parsePct, placeholder: '25%', suffix: 'of gross profit' },
    target: null,
    empty: 'Example: from 0% pay 20% of GP · from 15% GM pay 30% of GP. Deals below the first tier pay nothing.',
  },
};

function SectionEditor({ sectionKey, label, hint, section, onChange }: { sectionKey: QuotaSectionKey; label: string; hint: string; section: QuotaSection; onChange: (s: QuotaSection) => void }) {
  const u = UNITS[sectionKey];
  const [rows, setRows] = useState(() => section.rows.map((r) => ({ from: u.from.show(r.from), rate: u.rate.show(r.rate) })));
  const [target, setTarget] = useState(section.target === null ? '' : String(section.target));

  const commit = (next: { from: string; rate: string }[], patch: Partial<QuotaSection> = {}) => {
    setRows(next);
    onChange({ ...section, ...patch, rows: next.map((r) => ({ from: u.from.parse(r.from) ?? 0, rate: u.rate.parse(r.rate) ?? 0 })) });
  };
  const isMargin = sectionKey === 'percentOfMargin';
  const scale = sectionKey === 'percentOfQuota' ? section.target : null;

  return (
    <div className={`rounded-md border p-3 ${section.applies ? 'border-indigo-300 bg-panel' : 'border-slate-200 bg-slate-50'}`}>
      <div className="flex items-center gap-2 text-xs">
        <span className="text-sm font-semibold text-slate-700">{label}</span>
        <div className="flex-1" />
        <div className="inline-flex overflow-hidden rounded-md border border-slate-300">
          <button className={`px-2 py-1 ${section.applies ? 'bg-indigo-600 text-white' : 'bg-panel text-slate-500'}`} onClick={() => onChange({ ...section, applies: true })}>
            Applies
          </button>
          <button className={`px-2 py-1 ${!section.applies ? 'bg-slate-200 text-slate-800' : 'bg-panel text-slate-500'}`} onClick={() => onChange({ ...section, applies: false })}>
            Does not apply
          </button>
        </div>
      </div>
      <p className="mt-1 text-xs text-slate-400">{hint}</p>

      {section.applies && (
        <div className="mt-3 space-y-2 text-xs">
          <div className="flex flex-wrap items-end gap-3">
            {u.target && (
              <label className="text-slate-600">
                {u.target.label}
                <input
                  className="input mt-1 block w-36"
                  placeholder={u.target.placeholder}
                  value={target}
                  onChange={(e) => {
                    setTarget(e.target.value);
                    onChange({ ...section, target: parseNum(e.target.value) });
                  }}
                />
              </label>
            )}
            {!isMargin && (
              <label className="text-slate-600">
                Payout
                <select className="select mt-1 block" value={section.mode} onChange={(e) => onChange({ ...section, mode: e.target.value as QuotaSection['mode'] })}>
                  <option value="marginal">marginal — each tier's rate applies to its own slice</option>
                  <option value="whole">whole amount — the tier reached re-rates the deal</option>
                </select>
              </label>
            )}
            <div className="flex-1" />
            <button className="btn btn-sm" onClick={() => commit([...rows, { from: rows.length ? '' : u.from.show(0), rate: '' }])}>
              + Tier
            </button>
          </div>
          {u.target && <div className="text-slate-400">{u.target.hint}</div>}

          {rows.map((r, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="w-10 text-right text-slate-400">from</span>
              <input className="input w-28" placeholder={u.from.placeholder} value={r.from} onChange={(e) => commit(rows.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)))} />
              <span className="text-slate-400">{u.from.suffix} pay</span>
              <input className="input w-24" placeholder={u.rate.placeholder} value={r.rate} onChange={(e) => commit(rows.map((x, j) => (j === i ? { ...x, rate: e.target.value } : x)))} />
              <span className="text-slate-400">{u.rate.suffix}</span>
              <div className="flex-1" />
              <button className="text-slate-400 hover:text-rose-600" onClick={() => commit(rows.filter((_, j) => j !== i))}>
                ✕
              </button>
            </div>
          ))}
          {rows.length === 0 && <div className="text-slate-400">No tiers. {u.empty}</div>}
          {sectionKey === 'percentOfQuota' && (scale === null || scale <= 0) && rows.length > 0 && (
            <div className="text-amber-700">No quota here: each employee needs their own quota (or a default on their type) for these tiers to pay.</div>
          )}
          <SectionCheck sectionKey={sectionKey} section={section} />
        </div>
      )}
    </div>
  );
}

/** One worked example so the tiers can be sanity-checked as they are typed. */
function SectionCheck({ sectionKey, section }: { sectionKey: QuotaSectionKey; section: QuotaSection }) {
  if (!section.rows.length) return null;
  const tiers = sectionTiers(sectionKey, section);
  let text: string | null = null;
  if (sectionKey === 'percentOfMargin') {
    const rate = tierRate(0.2, tiers, null) ?? 0;
    text = `a $10,000 deal with $2,000 gross profit (20% GM) would pay ${money(2000 * rate)}`;
  } else if (sectionKey === 'percentOfQuota') {
    if (!section.target) return null;
    const v = section.target * 1.2;
    const pay = tierPayout(v, tiers, section.target);
    if (pay !== null) text = `${money(v)} booked (120% of quota) would pay ${money(pay)}`;
  } else if (sectionKey === 'dollars') {
    const v = section.target ? section.target * 1.2 : 120000;
    const pay = tierPayout(v, tiers, null);
    if (pay !== null) text = `${money(v)} booked would pay ${money(pay)}`;
  } else {
    const v = section.target ? Math.round(section.target * 1.2) : 50;
    const pay = tierPayout(v, tiers, null);
    if (pay !== null) text = `${v} units would pay ${money(pay)}`;
  }
  return text ? (
    <div className="text-slate-400">
      Check: <strong className="text-slate-600">{text}</strong>.
    </div>
  ) : null;
}
