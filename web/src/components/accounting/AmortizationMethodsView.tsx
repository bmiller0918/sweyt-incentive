// Amortization methods: how one capitalized commission spreads over months.
// A list, and a record page per method (like a depreciation method in a
// fixed-asset system): primary information, conventions, the formula, and a
// live preview on a sample commission.
import { FORMULA_VARIABLES, type AmortizationMethodDef } from '@commissions/shared';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, type AccountingSettingsRow, type AmortizationMethodRow, type MethodSchedule } from '../../api';
import { Bars, ErrorBar, Field, PageHeader, Section, money, monthLabel } from './ui';

export const KIND_LABELS: Record<AmortizationMethodDef['kind'], string> = {
  straight_line: 'Straight-line',
  yearly_percent: 'Percentage per year',
  monthly_percent: 'Percentage per month',
  formula: 'Formula',
  immediate: 'Expense immediately',
};

const START_LABELS: Record<AmortizationMethodDef['startBasis'], string> = {
  contract_start: 'the subscription start',
  pay_month: 'the pay month',
  month_after_pay: 'the month after the pay month',
};

const periodText = (def: AmortizationMethodDef) =>
  def.periodBasis === 'fixed_months' ? `${def.months} months` : def.termMultiplier && def.termMultiplier !== 1 ? `${def.termMultiplier}× the contract term` : 'the contract term';

/** One line describing a method in plain words. */
export function describeMethod(def: AmortizationMethodDef): string {
  if (def.kind === 'immediate') return 'Expensed in full when accrued; no asset.';
  const from = `from ${START_LABELS[def.startBasis]}`;
  if (def.kind === 'straight_line') return `Evenly over ${periodText(def)} ${from}.`;
  if (def.kind === 'formula') return `${def.formula || 'No formula'} each month over ${periodText(def)} ${from}.`;
  if (def.kind === 'yearly_percent') return `${def.yearPercents.map((p) => `${p}%`).join(' / ')} by year, even within each year, ${from}.`;
  return `${def.monthPercents.length} monthly percentages ${from}.`;
}

const blankDef = (): AmortizationMethodDef => ({
  kind: 'straight_line',
  periodBasis: 'contract_term',
  months: 48,
  termMultiplier: 1,
  yearPercents: [25, 25, 25, 25],
  monthPercents: [],
  startBasis: 'contract_start',
  formula: 'NB / RT',
});

/** Starting points for a formula method. */
const FORMULA_TEMPLATES: { label: string; formula: string; hint: string }[] = [
  { label: 'Straight-line', formula: 'NB / RT', hint: 'What is left, evenly over the months left.' },
  { label: 'Double declining', formula: 'MAX(NB * 2 / T, NB / RT)', hint: 'Front-loaded: twice the straight-line rate on what is left, switching to straight-line when that is larger.' },
  { label: '60% in year one', formula: 'IF(Y = 1, CV * 0.6 / MIN(12, T), NB / RT)', hint: 'Recognize 60% in the first year, the rest evenly after.' },
  { label: 'Back-loaded', formula: 'CV * CP / (T * (T + 1) / 2)', hint: 'Sum-of-the-months, growing each month.' },
];

type Draft = { name: string; description: string; def: AmortizationMethodDef };
const toDraft = (m: AmortizationMethodRow): Draft => ({ name: m.name, description: m.description ?? '', def: { ...blankDef(), ...m.def } });

/** A field that shows its value, or its input while editing. Module-level so inputs keep focus. */
function F({ label, view, edit, editing }: { label: string; view: ReactNode; edit: ReactNode; editing: boolean }) {
  return <Field label={label}>{editing ? edit : view}</Field>;
}

export function AmortizationMethodsView() {
  const [methods, setMethods] = useState<AmortizationMethodRow[] | null>(null);
  const [settings, setSettings] = useState<AccountingSettingsRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Which record is open: an id, 'new' (blank or a copy), or the list.
  const [open, setOpen] = useState<{ id: string | null; editing: boolean; draft?: Draft } | null>(null);

  const refresh = () =>
    Promise.all([api.listMethods(), api.getAccountingSettings()])
      .then(([m, s]) => {
        setMethods(m);
        setSettings(s);
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    refresh();
  }, []);

  if (!methods || !settings) return <div className="p-6 text-sm text-slate-400">{error ?? 'Loading…'}</div>;

  if (open) {
    const method = open.id ? (methods.find((m) => m.id === open.id) ?? null) : null;
    return (
      <MethodRecord
        key={`${open.id ?? 'new'}-${open.draft?.name ?? ''}`}
        method={method}
        initial={open.draft}
        editing={open.editing}
        settings={settings}
        onEdit={(editing) => setOpen({ ...open, editing })}
        onBack={() => setOpen(null)}
        onNew={(draft) => setOpen({ id: null, editing: true, draft })}
        onSaved={async (id) => {
          await refresh();
          setOpen(id ? { id, editing: false } : null);
        }}
      />
    );
  }

  return (
    <div className="flex h-full flex-col overflow-auto">
      <PageHeader
        section="Accounting"
        title="Amortization Methods"
        hint="How one capitalized commission spreads over months. Amortization types pick a method; build your own for ramped, front-loaded or formula-driven schedules."
      >
        <button className="btn btn-sm btn-primary" onClick={() => setOpen({ id: null, editing: true })}>
          New Method
        </button>
      </PageHeader>
      <ErrorBar error={error} onDismiss={() => setError(null)} />
      <div className="px-6 py-4">
        <table className="w-full bg-panel text-xs">
          <thead className="text-left text-slate-400">
            <tr className="border-b border-slate-200">
              <th className="py-1.5 pr-3 font-normal">View</th>
              <th className="py-1.5 pr-3 font-normal">Name</th>
              <th className="py-1.5 pr-3 font-normal">Calculation</th>
              <th className="py-1.5 pr-3 font-normal">How it spreads</th>
              <th className="py-1.5 pr-3 font-normal">Used by</th>
            </tr>
          </thead>
          <tbody>
            {methods.map((m) => (
              <tr key={m.id} className="cursor-pointer border-b border-slate-100 hover:bg-slate-50" onClick={() => setOpen({ id: m.id, editing: false })}>
                <td className="py-1.5 pr-3 text-indigo-700">View</td>
                <td className="py-1.5 pr-3 font-medium">
                  {m.name}
                  {settings.defaultMethodId === m.id && <span className="ml-1.5 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-700">default</span>}
                  {m.description && <div className="font-normal text-slate-400">{m.description}</div>}
                </td>
                <td className="py-1.5 pr-3">
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600">{KIND_LABELS[m.def.kind]}</span>
                </td>
                <td className="py-1.5 pr-3 text-slate-600">{describeMethod(m.def)}</td>
                <td className="py-1.5 pr-3 text-slate-500">{m.usedBy.length ? m.usedBy.join(', ') : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MethodRecord({
  method,
  initial,
  editing,
  settings,
  onEdit,
  onBack,
  onNew,
  onSaved,
}: {
  method: AmortizationMethodRow | null;
  initial?: Draft;
  editing: boolean;
  settings: AccountingSettingsRow;
  onEdit: (editing: boolean) => void;
  onBack: () => void;
  onNew: (draft: Draft) => void;
  onSaved: (id: string | null) => Promise<void>;
}) {
  const [draft, setDraft] = useState<Draft>(() => initial ?? (method ? toDraft(method) : { name: '', description: '', def: blankDef() }));
  const [monthText, setMonthText] = useState(draft.def.monthPercents.join(', '));
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const d = editing || !method ? draft : toDraft(method);
  const def = d.def;
  const setDef = (patch: Partial<AmortizationMethodDef>) => setDraft((x) => ({ ...x, def: { ...x.def, ...patch } }));
  const termed = def.kind === 'straight_line' || def.kind === 'formula';
  const isDefault = !!method && settings.defaultMethodId === method.id;

  const [sample, setSample] = useState({ amount: 12_000, payMonth: '2026-02', contractStart: '2026-02-01', termMonths: 36 });
  const [preview, setPreview] = useState<{ errors: string[]; schedule: MethodSchedule | null } | null>(null);
  useEffect(() => {
    const t = setTimeout(() => {
      api
        .previewMethod({ def, amount: sample.amount, payMonth: sample.payMonth, contractStart: sample.contractStart || null, termMonths: sample.termMonths || null, practicalExpedient: settings.practicalExpedient })
        .then(setPreview)
        .catch((e) => setPreview({ errors: [e.message], schedule: null }));
    }, 250);
    return () => clearTimeout(t);
  }, [def, sample, settings.practicalExpedient]);

  const yearly = useMemo(() => {
    const s = preview?.schedule;
    if (!s) return [];
    const by = new Map<number, number>();
    Object.keys(s.byMonth)
      .sort()
      .forEach((m, i) => by.set(Math.floor(i / 12) + 1, (by.get(Math.floor(i / 12) + 1) ?? 0) + s.byMonth[m]));
    return [...by.entries()];
  }, [preview]);

  const pctSum = (a: number[]) => Math.round(a.reduce((x, y) => x + y, 0) * 1000) / 1000;
  const save = async () => {
    try {
      const body = { name: draft.name.trim(), description: draft.description.trim() || null, def: draft.def };
      const row = method ? await api.updateMethod(method.id, body) : await api.createMethod(body);
      await onSaved(row.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const remove = async () => {
    if (!method) return;
    const usedBy = method.usedBy.length ? ` ${method.usedBy.join(', ')} will fall back to the company default.` : '';
    if (!window.confirm(`Delete "${method.name}"?${usedBy} The register keeps what it already booked.`)) return;
    try {
      await api.deleteMethod(method.id);
      await onSaved(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const copy = () => {
    setMenu(false);
    onNew({ ...d, name: `Copy of ${d.name}` });
  };

  return (
    <div className="flex h-full flex-col overflow-auto pb-8">
      <div className="border-b border-slate-200 px-6 py-4">
        <div className="text-xs text-slate-400">
          <button className="hover:underline" onClick={onBack}>
            Amortization Methods
          </button>
        </div>
        <div className="text-lg font-semibold">Amortization Method</div>
        <div className="flex items-center gap-2 text-slate-500">
          <span className="text-base">{method ? (editing ? draft.name || method.name : method.name) : draft.name || 'New method'}</span>
          {isDefault && <span className="rounded bg-emerald-100 px-1.5 text-[10px] text-emerald-700">Company default</span>}
        </div>
        <div className="mt-3 flex items-center gap-2">
          {editing ? (
            <>
              <button className="btn btn-sm btn-primary" disabled={!draft.name.trim() || !!preview?.errors.length} onClick={save}>
                Save
              </button>
              <button
                className="btn btn-sm"
                onClick={() => {
                  if (!method) return onBack();
                  setDraft(toDraft(method));
                  setMonthText(method.def.monthPercents.join(', '));
                  onEdit(false);
                }}
              >
                Cancel
              </button>
              {method && (
                <button className="btn btn-sm text-rose-700" onClick={remove}>
                  Delete
                </button>
              )}
            </>
          ) : (
            <>
              <button
                className="btn btn-sm btn-primary"
                onClick={() => {
                  setDraft(toDraft(method!));
                  setMonthText(method!.def.monthPercents.join(', '));
                  onEdit(true);
                }}
              >
                Edit
              </button>
              <button className="btn btn-sm" onClick={onBack}>
                Back
              </button>
              <div className="relative">
                <button className="btn btn-sm" onClick={() => setMenu((x) => !x)}>
                  Actions ▾
                </button>
                {menu && (
                  <div className="absolute left-0 z-10 mt-1 w-36 rounded-md border border-slate-200 bg-panel py-1 text-xs shadow-lg">
                    <button className="block w-full px-3 py-1.5 text-left hover:bg-slate-50" onClick={() => (setMenu(false), onNew({ name: '', description: '', def: blankDef() }))}>
                      New
                    </button>
                    <button className="block w-full px-3 py-1.5 text-left hover:bg-slate-50" onClick={copy}>
                      Make Copy
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
      <ErrorBar error={error} onDismiss={() => setError(null)} />

      <Section title="Primary Information">
        <F
          editing={editing}
          label="Name"
          view={d.name}
          edit={<input className="input mt-1 w-full" autoFocus placeholder="Ramped 3-year 20/30/50" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />}
        />
        <F
          editing={editing}
          label="Calculation"
          view={KIND_LABELS[def.kind]}
          edit={
            <select
              className="select mt-1 w-full"
              value={def.kind}
              onChange={(e) => {
                const kind = e.target.value as AmortizationMethodDef['kind'];
                setDef({ kind, yearPercents: kind === 'yearly_percent' && !def.yearPercents.length ? [100] : def.yearPercents, formula: def.formula || 'NB / RT' });
              }}
            >
              {(Object.keys(KIND_LABELS) as AmortizationMethodDef['kind'][]).map((k) => (
                <option key={k} value={k}>
                  {KIND_LABELS[k]}
                </option>
              ))}
            </select>
          }
        />
        <Field label="Used by">{method?.usedBy.length ? method.usedBy.join(', ') : <span className="text-slate-400">No amortization types</span>}</Field>
        <div className="col-span-3">
          <F
            editing={editing}
            label="Description"
            view={d.description || <span className="text-slate-400">{describeMethod(def)}</span>}
            edit={<input className="input mt-1 w-full" placeholder="When to use it" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />}
          />
        </div>
      </Section>

      {def.kind !== 'immediate' && (
        <Section title="Conventions">
          <F
            editing={editing}
            label="Amortization starts"
            view={`With ${START_LABELS[def.startBasis]}${def.startBasis === 'contract_start' ? ' (the pay month when a deal has none)' : ''}`}
            edit={
              <select className="select mt-1 w-full" value={def.startBasis} onChange={(e) => setDef({ startBasis: e.target.value as AmortizationMethodDef['startBasis'] })}>
                <option value="contract_start">With the subscription start (falls back to pay month)</option>
                <option value="pay_month">In the pay month</option>
                <option value="month_after_pay">The month after the pay month</option>
              </select>
            }
          />
          {termed ? (
            <>
              <F
                editing={editing}
                label="Period"
                view={def.periodBasis === 'fixed_months' ? 'A fixed number of months' : 'The contract term'}
                edit={
                  <select className="select mt-1 w-full" value={def.periodBasis} onChange={(e) => setDef({ periodBasis: e.target.value as AmortizationMethodDef['periodBasis'], months: def.months ?? 48 })}>
                    <option value="contract_term">The contract term</option>
                    <option value="fixed_months">A fixed number of months</option>
                  </select>
                }
              />
              {def.periodBasis === 'fixed_months' ? (
                <F
                  editing={editing}
                  label="Months"
                  view={`${def.months} months`}
                  edit={<input type="number" min={1} className="input mt-1 w-28" value={def.months ?? ''} onChange={(e) => setDef({ months: Number(e.target.value) || null })} />}
                />
              ) : (
                <F
                  editing={editing}
                  label="Term multiplier"
                  view={def.termMultiplier === 1 ? '1× (the term only)' : `${def.termMultiplier}× (covers expected renewals)`}
                  edit={
                    <input type="number" step={0.25} min={0.25} className="input mt-1 w-28" value={def.termMultiplier} onChange={(e) => setDef({ termMultiplier: Number(e.target.value) || 1 })} />
                  }
                />
              )}
            </>
          ) : (
            <Field label="Period">
              {def.kind === 'yearly_percent' ? `${def.yearPercents.length} years, set by the percentages` : `${def.monthPercents.length} months, set by the percentages`}
            </Field>
          )}
          <Field label="No term on the deal">{`Uses the company default of ${settings.defaultTermMonths} months, or the amortization type's own`}</Field>
          <Field label="Practical expedient">{settings.practicalExpedient ? 'On: schedules of 12 months or less are expensed' : 'Off'}</Field>
        </Section>
      )}

      {def.kind === 'immediate' && (
        <Section title="Formula Information" cols={2}>
          <Field label="Treatment">Expensed in full when accrued. Nothing is capitalized and nothing enters the register.</Field>
        </Section>
      )}

      {termed && (
        <div className="mx-6 mt-4">
          <div className="mb-2 rounded bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-600">Formula Information</div>
          <div className="grid grid-cols-[1fr_20rem] gap-6 px-3 text-xs">
            <div className="space-y-3">
              <Field label="Amount each month">
                {def.kind === 'straight_line' ? (
                  <span className="font-mono">CV / T</span>
                ) : editing ? (
                  <>
                    <textarea className="input mt-1 block h-16 w-full font-mono" value={def.formula ?? ''} placeholder="NB / RT" onChange={(e) => setDef({ formula: e.target.value })} />
                    <div className="mt-1 flex flex-wrap gap-1">
                      {FORMULA_TEMPLATES.map((t) => (
                        <button key={t.label} className="btn btn-sm" title={t.hint} onClick={() => setDef({ formula: t.formula })}>
                          {t.label}
                        </button>
                      ))}
                    </div>
                  </>
                ) : (
                  <span className="font-mono">{def.formula}</span>
                )}
              </Field>
              {def.kind === 'straight_line' && editing && (
                <div className="text-slate-400">Pick Formula as the calculation to write your own.</div>
              )}
              <Field label="After a modification">
                <span className="font-mono">NB / RT</span>
                <span className="ml-2 text-slate-400">What is left is spread evenly over the months left.</span>
              </Field>
              <div className="text-[11px] text-slate-400">
                Each month is capped at what is left and never goes below zero; the last month takes whatever remains, so the schedule always totals the commission. Functions: IF, MIN, MAX,
                ROUND, ABS, FLOOR, CEIL.
              </div>
            </div>
            <div className="rounded-md border border-slate-200 p-2">
              <div className="mb-1 font-semibold text-slate-600">Variables</div>
              <dl className="space-y-0.5">
                {FORMULA_VARIABLES.map((v) => (
                  <div key={v.name} className="grid grid-cols-[2.75rem_1fr] gap-1">
                    <dt className="font-mono text-slate-700">{v.name}</dt>
                    <dd className="text-slate-500">{v.label}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        </div>
      )}

      {def.kind === 'yearly_percent' && (
        <Section title="Formula Information" cols={2}>
          <div className="col-span-2 space-y-1 text-xs text-slate-600">
            <div>Percent of the commission recognized in each contract year, spread evenly over that year's 12 months.</div>
            <div className="flex flex-wrap items-center gap-2">
              {def.yearPercents.map((p, i) => (
                <label key={i} className="flex items-center gap-1">
                  Y{i + 1}
                  {editing ? (
                    <input
                      type="number"
                      min={0}
                      max={100}
                      className="input w-16"
                      value={p}
                      onChange={(e) => setDef({ yearPercents: def.yearPercents.map((x, j) => (j === i ? Number(e.target.value) || 0 : x)) })}
                    />
                  ) : (
                    <span className="font-medium text-slate-800">{p}</span>
                  )}
                  %
                </label>
              ))}
              {editing && (
                <>
                  <button className="btn btn-sm" onClick={() => setDef({ yearPercents: [...def.yearPercents, 0] })}>
                    + Year
                  </button>
                  {def.yearPercents.length > 1 && (
                    <button className="btn btn-sm" onClick={() => setDef({ yearPercents: def.yearPercents.slice(0, -1) })}>
                      − Year
                    </button>
                  )}
                </>
              )}
              <span className={pctSum(def.yearPercents) === 100 ? 'text-emerald-700' : 'text-amber-700'}>Total {pctSum(def.yearPercents)}%</span>
            </div>
          </div>
        </Section>
      )}

      {def.kind === 'monthly_percent' && (
        <Section title="Formula Information" cols={2}>
          <div className="col-span-2 text-xs text-slate-600">
            Percent per month, first month first. Must total 100%.
            {editing ? (
              <textarea
                className="input mt-1 block h-16 w-full font-mono"
                value={monthText}
                placeholder="10, 10, 10, 5, 5, 5, ..."
                onChange={(e) => {
                  setMonthText(e.target.value);
                  setDef({ monthPercents: e.target.value.split(/[,\s]+/).filter(Boolean).map(Number).filter((n) => Number.isFinite(n)) });
                }}
              />
            ) : (
              <div className="mt-1 font-mono text-slate-800">{def.monthPercents.join(', ')}</div>
            )}
            <span className={pctSum(def.monthPercents) === 100 ? 'text-emerald-700' : 'text-amber-700'}>
              {def.monthPercents.length} months · total {pctSum(def.monthPercents)}%
            </span>
          </div>
        </Section>
      )}

      {def.kind !== 'immediate' && (
        <div className="mx-6 mt-4">
          <div className="mb-2 rounded bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-600">Preview</div>
          <div className="space-y-2 px-3 text-xs">
            <div className="flex flex-wrap items-center gap-3 text-slate-600">
              <label className="flex items-center gap-1">
                Commission
                <input type="number" className="input w-24" value={sample.amount} onChange={(e) => setSample({ ...sample, amount: Number(e.target.value) || 0 })} />
              </label>
              <label className="flex items-center gap-1">
                Pay month
                <input type="month" className="input" value={sample.payMonth} onChange={(e) => setSample({ ...sample, payMonth: e.target.value })} />
              </label>
              <label className="flex items-center gap-1">
                Subscription start
                <input type="date" className="input" value={sample.contractStart} onChange={(e) => setSample({ ...sample, contractStart: e.target.value })} />
              </label>
              <label className="flex items-center gap-1">
                Term
                <input type="number" className="input w-16" value={sample.termMonths} onChange={(e) => setSample({ ...sample, termMonths: Number(e.target.value) || 0 })} />
                months
              </label>
            </div>
            {preview?.errors.length ? (
              <div className="text-amber-700">{preview.errors.join(' ')}</div>
            ) : preview?.schedule ? (
              preview.schedule.capitalize ? (
                <>
                  <Bars data={Object.entries(preview.schedule.byMonth).map(([m, v]) => ({ label: monthLabel(m), value: v }))} />
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-slate-500">
                    <span>
                      {monthLabel(preview.schedule.startMonth)} for {preview.schedule.months} months
                    </span>
                    <span>
                      First month <span className="text-slate-700">{money(preview.schedule.byMonth[preview.schedule.startMonth])}</span>
                    </span>
                    {yearly.map(([y, v]) => (
                      <span key={y}>
                        Year {y}: <span className="text-slate-700">{money(Math.round(v * 100) / 100)}</span>
                      </span>
                    ))}
                  </div>
                </>
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
      )}
    </div>
  );
}
