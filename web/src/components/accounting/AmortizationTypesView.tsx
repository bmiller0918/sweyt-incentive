import type { GlAccount } from '@commissions/shared';
import { useEffect, useState } from 'react';
import { api, type AccountingSettingsRow, type AmortizationMethodRow, type AmortizationTypeInput, type AmortizationTypeRow, type AmortizationTypesPayload } from '../../api';
import { describeMethod } from './AccountingSettingsView';
import { ErrorBar, PageHeader } from './ui';

const empty = (): AmortizationTypeInput => ({ name: '', description: '', treatment: 'capitalize', methodId: null, expenseAccount: null, amortizationAccount: null, employeeTypeIds: [] });

export function AmortizationTypesView() {
  const [data, setData] = useState<AmortizationTypesPayload | null>(null);
  const [methods, setMethods] = useState<AmortizationMethodRow[]>([]);
  const [settings, setSettings] = useState<AccountingSettingsRow | null>(null);
  const [selected, setSelected] = useState<string | 'new' | null>(null);
  const [draft, setDraft] = useState<AmortizationTypeInput>(empty());
  const [error, setError] = useState<string | null>(null);

  const select = (t: AmortizationTypeRow | 'new', payload = data) => {
    if (t === 'new') {
      setSelected('new');
      setDraft(empty());
      return;
    }
    setSelected(t.id);
    const fresh = payload?.types.find((x) => x.id === t.id) ?? t;
    setDraft({
      name: fresh.name,
      description: fresh.description ?? '',
      treatment: fresh.treatment,
      methodId: fresh.methodId,
      expenseAccount: fresh.expenseAccount,
      amortizationAccount: fresh.amortizationAccount,
      employeeTypeIds: fresh.employeeTypes.map((e) => e.id),
    });
  };

  useEffect(() => {
    Promise.all([api.listAmortizationTypes(), api.listMethods(), api.getAccountingSettings()])
      .then(([d, m, s]) => {
        setData(d);
        setMethods(m);
        setSettings(s);
        if (d.types.length) select(d.types[0], d);
        else select('new', d);
      })
      .catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const apply = (d: AmortizationTypesPayload, keepId?: string) => {
    setData(d);
    const t = d.types.find((x) => x.id === keepId) ?? d.types.find((x) => x.name === draft.name) ?? d.types[0];
    if (t) select(t, d);
    else select('new', d);
  };

  const save = async () => {
    try {
      const body = { ...draft, name: draft.name.trim(), description: draft.description?.trim() || null };
      if (selected === 'new' || !selected) apply(await api.createAmortizationType(body));
      else apply(await api.updateAmortizationType(selected, body), selected);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const remove = async () => {
    if (!selected || selected === 'new') return;
    const t = data?.types.find((x) => x.id === selected);
    if (!t || !window.confirm(`Delete "${t.name}"? Its roles fall back to their own treatment and the default method. The register keeps what it already booked.`)) return;
    try {
      apply(await api.deleteAmortizationType(selected));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!data || !settings) return <div className="p-6 text-sm text-slate-400">{error ?? 'Loading…'}</div>;
  const defaultMethod = methods.find((m) => m.id === settings.defaultMethodId);
  const methodOf = (t: { methodId: string | null }) => methods.find((m) => m.id === t.methodId) ?? null;
  const unmapped = data.employeeTypes.filter((e) => !e.amortizationTypeId);
  const suggestions = unmapped.filter((e) => e.suggestedTypeId);
  const typeName = (id: string | null) => data.types.find((t) => t.id === id)?.name ?? '';
  const roleOwner = (roleId: string) => data.types.find((t) => t.id !== selected && t.employeeTypes.some((e) => e.id === roleId));

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        section="Accounting"
        title="Amortization Types"
        hint="A type groups roles that are accounted for the same way. AEs and solutions engineers are paid because a contract signs, so their commissions are capitalized; SDRs are usually paid for meetings, so theirs are expensed. Each employee type points at one amortization type."
      />
      <ErrorBar error={error} onDismiss={() => setError(null)} />

      {unmapped.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-amber-200 bg-amber-50 px-6 py-2 text-xs text-amber-800">
          <span>
            {unmapped.length} employee type{unmapped.length === 1 ? ' has' : 's have'} no amortization type: {unmapped.map((e) => e.name).join(', ')}.
          </span>
          {suggestions.length > 0 && (
            <>
              <span className="text-amber-700">Suggested: {suggestions.map((e) => `${e.name} → ${typeName(e.suggestedTypeId)}`).join(', ')}.</span>
              <button
                className="btn btn-sm"
                onClick={() =>
                  api
                    .assignAmortizationTypes(suggestions.map((e) => ({ employeeTypeId: e.id, amortizationTypeId: e.suggestedTypeId })))
                    .then((d) => apply(d, selected ?? undefined))
                    .catch((err) => setError(err.message))
                }
              >
                Apply suggestions
              </button>
            </>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-72 shrink-0 flex-col border-r border-slate-200 bg-panel">
          <div className="flex items-center border-b border-slate-200 px-3 py-2">
            <span className="text-sm font-semibold">Types</span>
            <div className="flex-1" />
            <button className="btn btn-sm btn-primary" onClick={() => select('new')}>
              + New
            </button>
          </div>
          <div className="flex-1 overflow-auto p-2">
            {data.types.map((t) => (
              <button
                key={t.id}
                onClick={() => select(t)}
                className={`block w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-slate-100 ${selected === t.id ? 'bg-indigo-50 text-indigo-700' : 'text-slate-700'}`}
              >
                <div className="flex items-center gap-1.5">
                  <span className="truncate font-medium">{t.name}</span>
                  <span className={`rounded px-1 text-[10px] ${t.treatment === 'expense' ? 'bg-rose-100 text-rose-700' : 'bg-emerald-100 text-emerald-700'}`}>{t.treatment === 'expense' ? 'expense' : 'capitalize'}</span>
                </div>
                <div className="truncate text-xs text-slate-400">{t.employeeTypes.length ? t.employeeTypes.map((e) => e.name).join(', ') : 'no roles yet'}</div>
              </button>
            ))}
          </div>
        </aside>

        <div className="min-w-0 flex-1 overflow-auto">
          <div className="mx-auto w-full max-w-3xl space-y-6 p-6 text-xs">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold">{selected === 'new' ? 'New amortization type' : draft.name || 'Amortization type'}</h2>
              <div className="flex-1" />
              {selected !== 'new' && (
                <button className="btn text-rose-600" onClick={remove}>
                  Delete
                </button>
              )}
              <button className="btn btn-primary" disabled={!draft.name.trim()} onClick={save}>
                Save
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="col-span-2 text-slate-600">
                Name
                <input className="input mt-1 block w-full" placeholder="Account Executives" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </label>
              <label className="col-span-2 text-slate-600">
                Why this treatment <span className="text-slate-400">(kept as audit support for the policy)</span>
                <textarea className="input mt-1 block h-16 w-full" value={draft.description ?? ''} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
              </label>
            </div>

            <div className="space-y-1">
              <div className="font-semibold text-slate-600">Treatment</div>
              <label className="flex items-start gap-2 text-slate-600">
                <input type="radio" className="mt-0.5" checked={draft.treatment === 'capitalize'} onChange={() => setDraft({ ...draft, treatment: 'capitalize' })} />
                <span>
                  Capitalize and amortize <span className="text-slate-400">— incremental: paid only because a contract was signed (ASC 340-40-25-1).</span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-slate-600">
                <input type="radio" className="mt-0.5" checked={draft.treatment === 'expense'} onChange={() => setDraft({ ...draft, treatment: 'expense' })} />
                <span>
                  Expense when accrued <span className="text-slate-400">— not incremental (meetings, pipeline, discretionary or team bonuses).</span>
                </span>
              </label>
            </div>

            {draft.treatment === 'capitalize' && (
              <label className="block text-slate-600">
                Amortization method
                <select className="select mt-1 block w-full" value={draft.methodId ?? ''} onChange={(e) => setDraft({ ...draft, methodId: e.target.value || null })}>
                  <option value="">Company default{defaultMethod ? ` (${defaultMethod.name})` : ''}</option>
                  {methods.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
                <span className="mt-1 block text-slate-400">{(() => {
                    const m = methodOf(draft) ?? defaultMethod;
                    return m ? describeMethod(m.def) : '';
                  })()}</span>
              </label>
            )}

            <div className="space-y-2">
              <div className="font-semibold text-slate-600">Roles (employee types)</div>
              <div className="grid grid-cols-2 gap-1">
                {data.employeeTypes.map((e) => {
                  const owner = roleOwner(e.id);
                  const checked = draft.employeeTypeIds?.includes(e.id) ?? false;
                  return (
                    <label key={e.id} className="flex items-center gap-2 rounded px-2 py-1 text-slate-700 hover:bg-slate-100">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(ev) =>
                          setDraft({ ...draft, employeeTypeIds: ev.target.checked ? [...(draft.employeeTypeIds ?? []), e.id] : (draft.employeeTypeIds ?? []).filter((x) => x !== e.id) })
                        }
                      />
                      <span className="flex-1">{e.name}</span>
                      {owner && !checked && <span className="text-[10px] text-slate-400">now: {owner.name}</span>}
                    </label>
                  );
                })}
                {data.employeeTypes.length === 0 && <div className="text-slate-400">No employee types yet. Add them under Employees › Employee types.</div>}
              </div>
              <div className="text-slate-400">Checking a role moves it here from any other type. Saving applies to the next monthly close; closed months keep what they booked.</div>
            </div>

            <div className="space-y-2">
              <div className="font-semibold text-slate-600">GL overrides (optional)</div>
              <AccountOverride label={draft.treatment === 'expense' ? 'Commission expense account' : 'Commission expense account (used if a line is expensed)'} value={draft.expenseAccount} fallback={settings.accounts.commissionExpense} onChange={(v) => setDraft({ ...draft, expenseAccount: v })} />
              {draft.treatment === 'capitalize' && (
                <AccountOverride label="Amortization expense account" value={draft.amortizationAccount} fallback={settings.accounts.amortizationExpense} onChange={(v) => setDraft({ ...draft, amortizationAccount: v })} />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function AccountOverride({ label, value, fallback, onChange }: { label: string; value: GlAccount | null; fallback: GlAccount; onChange: (v: GlAccount | null) => void }) {
  return (
    <div className="flex items-center gap-2 text-slate-600">
      <label className="flex w-72 items-center gap-2">
        <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked ? { ...fallback } : null)} />
        {label}
      </label>
      {value ? (
        <>
          <input className="input w-20 font-mono" value={value.number} onChange={(e) => onChange({ ...value, number: e.target.value })} />
          <input className="input flex-1" value={value.name} onChange={(e) => onChange({ ...value, name: e.target.value })} />
        </>
      ) : (
        <span className="text-slate-400">
          Default: {fallback.number} {fallback.name}
        </span>
      )}
    </div>
  );
}
