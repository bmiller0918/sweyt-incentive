// Weighted components of a comp plan: the target incentive is split across
// components by weight (a % of it, a dollar amount, or in proportion to the
// component's quota); each component has a quota and a tier table of
// attainment → % of the on-target rate.
import { componentPayout, resolveStructure, type ComponentWeight, type PlanComponent, type PlanStructure, type ResolvedComponent } from '@commissions/shared';
import { useState } from 'react';

type WeightKind = ComponentWeight['kind'];

/** Text the user is typing, kept beside the parsed structure so partial input survives. */
interface CompText {
  weight: string;
  quota: string;
  tiers: { from: string; rate: string }[];
}

/** "8%" -> 0.08, "$50,000" -> 50000, "" -> null. */
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
const pct = (n: number, digits = 2) => `${Math.round(n * 100 * 10 ** digits) / 10 ** digits}%`;
const money = (n: number) => n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

const newId = () => Math.random().toString(36).slice(2, 10);

function textOf(c: PlanComponent): CompText {
  return {
    weight: c.weight.kind === 'percent' ? pct(c.weight.value) : c.weight.kind === 'amount' ? String(c.weight.value) : '',
    quota: c.quota === null ? '' : String(c.quota),
    tiers: c.tiers.rows.map((r) => ({ from: pct(r.from), rate: pct(r.rate) })),
  };
}

/** The weight text re-expressed in the new kind (percent ↔ amount via the target incentive), or '' when it cannot be converted. */
function convertWeightText(from: WeightKind, to: WeightKind, text: string, targetIncentive: number | null): string {
  if (from === to) return text;
  if (to === 'quota' || from === 'quota') return '';
  const n = parseNum(text);
  if (n === null || !targetIncentive) return '';
  if (from === 'percent' && to === 'amount') return String(Math.round(n * targetIncentive * 100) / 100);
  if (from === 'amount' && to === 'percent') return pct(n / targetIncentive, 2);
  return '';
}

function weightFrom(kind: WeightKind, text: string): ComponentWeight {
  if (kind === 'quota') return { kind };
  const n = parseNum(text) ?? 0;
  return { kind, value: n };
}

interface Props {
  structure: PlanStructure;
  onChange: (s: PlanStructure) => void;
}

/**
 * Remount (key it by plan id) when a different plan loads: the typed text is
 * seeded from the structure once.
 */
export function PlanStructureEditor({ structure, onChange }: Props) {
  const [tiText, setTiText] = useState(structure.targetIncentive === null ? '' : String(structure.targetIncentive));
  const [texts, setTexts] = useState<Record<string, CompText>>(() => Object.fromEntries(structure.components.map((c) => [c.id, textOf(c)])));

  const resolved = resolveStructure(structure);
  const byId = new Map(resolved.components.map((c) => [c.id, c]));

  const setComponent = (id: string, patch: Partial<PlanComponent>) => onChange({ ...structure, components: structure.components.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
  const setText = (id: string, patch: Partial<CompText>) => setTexts((t) => ({ ...t, [id]: { ...t[id], ...patch } }));

  const addComponent = () => {
    const c: PlanComponent = { id: newId(), name: '', weight: { kind: 'percent', value: 0 }, quota: null, tiers: { mode: 'marginal', rows: [] } };
    setTexts((t) => ({ ...t, [c.id]: textOf(c) }));
    onChange({ ...structure, components: [...structure.components, c] });
  };
  const removeComponent = (id: string) => onChange({ ...structure, components: structure.components.filter((c) => c.id !== id) });

  const weightLabel = (c: PlanComponent) => (c.weight.kind === 'percent' ? '% of target incentive' : c.weight.kind === 'amount' ? '$ of target incentive' : 'in proportion to quota');

  return (
    <div>
      <div className="mb-1 flex items-center text-xs">
        <span className="font-semibold text-slate-600">Weighted components</span>
        <span className="ml-2 text-slate-400">
          split the target incentive by weight; each component has its own quota and attainment tiers — <code>COMPONENT(x, "New ARR")</code> in Calculate
        </span>
        <div className="flex-1" />
        <button className="btn btn-sm" onClick={addComponent}>
          + Component
        </button>
      </div>

      <div className="mb-2 flex flex-wrap items-center gap-3 text-xs">
        <label className="text-slate-600">
          Target incentive{' '}
          <input
            className="input w-32"
            placeholder="100000"
            value={tiText}
            onChange={(e) => {
              setTiText(e.target.value);
              onChange({ ...structure, targetIncentive: parseNum(e.target.value) });
            }}
          />
          <span className="ml-1 text-slate-400">variable pay at 100% on every component</span>
        </label>
        {structure.components.length > 0 && (
          <span className={resolved.weightTotal !== null && Math.abs(resolved.weightTotal - 1) < 1e-6 ? 'text-emerald-700' : 'text-amber-700'}>
            Weights: {resolved.weightTotal === null ? '—' : pct(resolved.weightTotal, 1)}
            {resolved.targetIncentive !== null && structure.targetIncentive === null ? ` · target incentive ${money(resolved.targetIncentive)} from the amounts` : ''}
          </span>
        )}
      </div>

      {resolved.issues.length > 0 && (
        <ul className="mb-2 space-y-0.5 text-xs text-amber-700">
          {resolved.issues.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      )}

      <div className="space-y-2">
        {structure.components.map((c) => {
          const t = texts[c.id] ?? textOf(c);
          const r = byId.get(c.id);
          return (
            <ComponentCard
              key={c.id}
              c={c}
              t={t}
              r={r}
              weightLabel={weightLabel(c)}
              onName={(name) => setComponent(c.id, { name })}
              onWeightKind={(kind) => {
                // A "60%" typed as a percent must not become $0.60: convert via the
                // target incentive when it is known, otherwise start the field blank.
                const text = convertWeightText(c.weight.kind, kind, t.weight, resolved.targetIncentive);
                setText(c.id, { weight: text });
                setComponent(c.id, { weight: weightFrom(kind, text) });
              }}
              onWeightText={(text) => {
                setText(c.id, { weight: text });
                setComponent(c.id, { weight: weightFrom(c.weight.kind, text) });
              }}
              onQuota={(text) => {
                setText(c.id, { quota: text });
                setComponent(c.id, { quota: parseNum(text) });
              }}
              onMode={(mode) => setComponent(c.id, { tiers: { ...c.tiers, mode } })}
              onTiers={(rows) => {
                setText(c.id, { tiers: rows });
                setComponent(c.id, { tiers: { ...c.tiers, rows: rows.map((x) => ({ from: parseNum(x.from) ?? 0, rate: parseNum(x.rate) ?? 0 })) } });
              }}
              onRemove={() => removeComponent(c.id)}
            />
          );
        })}
        {structure.components.length === 0 && (
          <div className="text-xs text-slate-400">No components. Example: New ARR 60% on a $1.2M quota · Renewals 40% on $2M — each with tiers like from 100% attainment pay 150%.</div>
        )}
      </div>
    </div>
  );
}

function ComponentCard({
  c,
  t,
  r,
  weightLabel,
  onName,
  onWeightKind,
  onWeightText,
  onQuota,
  onMode,
  onTiers,
  onRemove,
}: {
  c: PlanComponent;
  t: CompText;
  r: ResolvedComponent | undefined;
  weightLabel: string;
  onName: (s: string) => void;
  onWeightKind: (k: WeightKind) => void;
  onWeightText: (s: string) => void;
  onQuota: (s: string) => void;
  onMode: (m: 'marginal' | 'whole') => void;
  onTiers: (rows: { from: string; rate: string }[]) => void;
  onRemove: () => void;
}) {
  const quota = c.quota ?? 0;
  const sample = quota * 1.2;
  const preview = r && r.rate !== null && quota > 0 ? componentPayout(sample, r) : null;

  return (
    <div className="rounded-md border border-slate-200 bg-panel p-3 text-xs">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-slate-600">
          Component
          <input className="input mt-1 block w-40" placeholder="New ARR" value={c.name} onChange={(e) => onName(e.target.value)} />
        </label>
        <label className="text-slate-600">
          Weight
          <div className="mt-1 flex items-center gap-1">
            {c.weight.kind !== 'quota' && <input className="input w-24" placeholder={c.weight.kind === 'percent' ? '60%' : '60000'} value={t.weight} onChange={(e) => onWeightText(e.target.value)} />}
            <select className="select" value={c.weight.kind} onChange={(e) => onWeightKind(e.target.value as WeightKind)}>
              <option value="percent">% of target incentive</option>
              <option value="amount">$ amount</option>
              <option value="quota">by quota</option>
            </select>
          </div>
        </label>
        <label className="text-slate-600">
          Quota
          <input className="input mt-1 block w-32" placeholder="1200000" value={t.quota} onChange={(e) => onQuota(e.target.value)} />
        </label>
        <div className="flex-1" />
        <button className="text-slate-400 hover:text-rose-600" onClick={onRemove} title="Remove component">
          ✕
        </button>
      </div>
      <div className="mt-1.5 text-slate-500">
        {r && r.targetIncentive !== null ? (
          <>
            {weightLabel} → <strong className="text-slate-700">{money(r.targetIncentive)}</strong>
            {r.weight !== null && c.weight.kind !== 'percent' ? <span className="text-slate-400"> ({pct(r.weight, 1)})</span> : null}
            {r.rate !== null && r.quota !== null ? (
              <>
                {' '}
                · on-target rate <strong className="text-slate-700">{pct(r.rate, 3)}</strong>
                <span className="text-slate-400">
                  {' '}
                  ({money(r.targetIncentive)} ÷ {money(r.quota)})
                </span>
              </>
            ) : null}
          </>
        ) : (
          <span className="text-slate-400">{weightLabel}</span>
        )}
      </div>
      {r && r.issues.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-amber-700">
          {r.issues.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="shrink-0 font-semibold text-slate-600">Attainment tiers</span>
        <span className="text-slate-400">attainment % of quota → % of the on-target rate</span>
        <div className="flex-1" />
        <label className="shrink-0 text-slate-600">
          Payout{' '}
          <select className="select" value={c.tiers.mode} onChange={(e) => onMode(e.target.value as 'marginal' | 'whole')}>
            <option value="marginal">marginal — each tier's rate applies to its own slice</option>
            <option value="whole">whole amount — the highest tier reached re-rates everything</option>
          </select>
        </label>
        <button className="btn btn-sm shrink-0" onClick={() => onTiers([...t.tiers, { from: t.tiers.length ? '' : '0%', rate: t.tiers.length ? '' : '100%' }])}>
          + Tier
        </button>
      </div>
      <div className="mt-1 space-y-1">
        {t.tiers.map((row, i) => {
          const mult = parseNum(row.rate);
          return (
            <div key={i} className="flex items-center gap-2">
              <span className="w-10 text-right text-slate-400">from</span>
              <input className="input w-20" placeholder="100%" value={row.from} onChange={(e) => onTiers(t.tiers.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)))} />
              <span className="text-slate-400">attainment pay</span>
              <input className="input w-20" placeholder="150%" value={row.rate} onChange={(e) => onTiers(t.tiers.map((x, j) => (j === i ? { ...x, rate: e.target.value } : x)))} />
              <span className="text-slate-400">of the on-target rate{r && r.rate !== null && mult !== null ? ` → ${pct(r.rate * mult, 3)} of the amount` : ''}</span>
              <div className="flex-1" />
              <button className="text-slate-400 hover:text-rose-600" onClick={() => onTiers(t.tiers.filter((_, j) => j !== i))}>
                ✕
              </button>
            </div>
          );
        })}
        {t.tiers.length === 0 && <div className="text-slate-400">No tiers: pays the on-target rate on everything. Example: from 0% pay 100% · from 100% pay 150%.</div>}
        {preview !== null && (
          <div className="text-slate-400">
            Check: 120% attainment ({money(sample)}) would pay <strong className="text-slate-600">{money(preview)}</strong>.
          </div>
        )}
      </div>
    </div>
  );
}
