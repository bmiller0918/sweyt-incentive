// Amortization types: how a group of roles' commissions are accounted for.
// A list of types, and a record page per type (like a fixed-asset type):
// defaults for new amortizations, the GL accounts it books to, and the roles in it.
import type { GlAccount } from '@commissions/shared';
import { useEffect, useState, type ReactNode } from 'react';
import { api, type AccountingSettingsRow, type AmortizationMethodRow, type AmortizationTypeInput, type AmortizationTypeRow, type AmortizationTypesPayload, type TypeAccountOverrides } from '../../api';
import { describeMethod } from './AmortizationMethodsView';
import { ErrorBar, Field, PageHeader, Section, money, monthLabel } from './ui';

const START_LABEL: Record<string, string> = { contract_start: 'Subscription start', pay_month: 'Pay month', month_after_pay: 'Month after pay' };
const emptyType = (): AmortizationTypeInput => ({
  name: '',
  description: '',
  treatment: 'capitalize',
  methodId: null,
  expenseAccount: null,
  amortizationAccount: null,
  accounts: {},
  defaultTermMonths: null,
  inactive: false,
  employeeTypeIds: [],
});
const toInput = (t: AmortizationTypeRow): AmortizationTypeInput => ({
  name: t.name,
  description: t.description ?? '',
  treatment: t.treatment,
  methodId: t.methodId,
  expenseAccount: t.expenseAccount,
  amortizationAccount: t.amortizationAccount,
  accounts: t.accounts ?? {},
  defaultTermMonths: t.defaultTermMonths,
  inactive: t.inactive,
  employeeTypeIds: t.employeeTypes.map((e) => e.id),
});

type View = { kind: 'list' } | { kind: 'record'; id: string; editing: boolean } | { kind: 'new' };

export function AmortizationTypesView() {
  const [data, setData] = useState<AmortizationTypesPayload | null>(null);
  const [methods, setMethods] = useState<AmortizationMethodRow[]>([]);
  const [settings, setSettings] = useState<AccountingSettingsRow | null>(null);
  const [view, setView] = useState<View>({ kind: 'list' });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.listAmortizationTypes(), api.listMethods(), api.getAccountingSettings()])
      .then(([d, m, s]) => {
        setData(d);
        setMethods(m);
        setSettings(s);
      })
      .catch((e) => setError(e.message));
  }, []);

  if (!data || !settings) return <div className="p-6 text-sm text-slate-400">{error ?? 'Loading…'}</div>;
  const ctx = { data, methods, settings };

  if (view.kind === 'new' || view.kind === 'record') {
    const type = view.kind === 'record' ? data.types.find((t) => t.id === view.id) : undefined;
    if (view.kind === 'record' && !type) return <div className="p-6 text-sm text-slate-400">Type not found.</div>;
    return (
      <TypeRecord
        key={view.kind === 'record' ? view.id : 'new'}
        ctx={ctx}
        type={type ?? null}
        editing={view.kind === 'new' || (view.kind === 'record' && view.editing)}
        onEdit={(editing) => type && setView({ kind: 'record', id: type.id, editing })}
        onBack={() => setView({ kind: 'list' })}
        onSaved={(d, id) => {
          setData(d);
          setView(id ? { kind: 'record', id, editing: false } : { kind: 'list' });
        }}
      />
    );
  }

  const methodOf = (t: AmortizationTypeRow) => methods.find((m) => m.id === (t.methodId ?? settings.defaultMethodId)) ?? null;
  const unmapped = data.employeeTypes.filter((e) => !e.amortizationTypeId);
  const suggestions = unmapped.filter((e) => e.suggestedTypeId);
  const typeName = (id: string | null) => data.types.find((t) => t.id === id)?.name ?? '';

  return (
    <div className="flex h-full flex-col overflow-auto">
      <PageHeader
        section="Accounting"
        title="Amortization Types"
        hint="A type groups roles whose commissions are accounted for the same way: capitalized and amortized (AEs, solutions engineers) or expensed (SDRs paid for meetings). It sets the default method and term, and the GL accounts its amortizations book to."
      >
        <button className="btn btn-sm btn-primary" onClick={() => setView({ kind: 'new' })}>
          New Type
        </button>
      </PageHeader>
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
                    .then(setData)
                    .catch((err) => setError(err.message))
                }
              >
                Apply suggestions
              </button>
            </>
          )}
        </div>
      )}
      <div className="p-6">
        <table className="w-full bg-panel text-xs">
          <thead className="text-left text-slate-400">
            <tr className="border-b border-slate-200">
              <th className="py-1.5 pr-3 font-normal">View</th>
              <th className="py-1.5 pr-3 font-normal">Name</th>
              <th className="py-1.5 pr-3 font-normal">Treatment</th>
              <th className="py-1.5 pr-3 font-normal">Default method</th>
              <th className="py-1.5 pr-3 text-right font-normal">Default term</th>
              <th className="py-1.5 pr-3 font-normal">Asset / expense account</th>
              <th className="py-1.5 pr-3 font-normal">Roles</th>
              <th className="py-1.5 pr-3 text-right font-normal">Amortizations</th>
              <th className="py-1.5 pr-3 text-right font-normal">Balance{data.asOf ? ` ${monthLabel(data.asOf)}` : ''}</th>
              <th className="py-1.5 font-normal">Status</th>
            </tr>
          </thead>
          <tbody>
            {data.types.map((t) => {
              const A = accountsFor(t, settings);
              return (
                <tr key={t.id} className={`cursor-pointer border-b border-slate-100 hover:bg-slate-50 ${t.inactive ? 'text-slate-400' : ''}`} onClick={() => setView({ kind: 'record', id: t.id, editing: false })}>
                  <td className="py-1.5 pr-3 text-indigo-700">View</td>
                  <td className="py-1.5 pr-3 font-medium">{t.name}</td>
                  <td className="py-1.5 pr-3">
                    <TreatmentBadge treatment={t.treatment} />
                  </td>
                  <td className="py-1.5 pr-3">{t.treatment === 'expense' ? '—' : (methodOf(t)?.name ?? '—')}</td>
                  <td className="py-1.5 pr-3 text-right">{t.treatment === 'expense' ? '—' : `${t.defaultTermMonths ?? settings.defaultTermMonths} mo`}</td>
                  <td className="py-1.5 pr-3 whitespace-nowrap">{t.treatment === 'expense' ? <Acct a={A.commissionExpense} /> : <Acct a={A.deferredNoncurrent} />}</td>
                  <td className="py-1.5 pr-3">{t.employeeTypes.length ? t.employeeTypes.map((e) => e.name).join(', ') : <span className="text-slate-400">None</span>}</td>
                  <td className="py-1.5 pr-3 text-right">{t.usage.count || ''}</td>
                  <td className="py-1.5 pr-3 text-right">{t.usage.balance ? money(t.usage.balance) : ''}</td>
                  <td className="py-1.5">{t.inactive ? 'Inactive' : 'Active'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

type Ctx = { data: AmortizationTypesPayload; methods: AmortizationMethodRow[]; settings: AccountingSettingsRow };

/** Every account a type books to, with its own overrides applied. */
function accountsFor(t: Pick<AmortizationTypeInput, 'expenseAccount' | 'amortizationAccount' | 'accounts'>, settings: AccountingSettingsRow) {
  const A = settings.accounts;
  const o = t.accounts ?? {};
  return {
    deferredCurrent: o.deferredCurrent ?? A.deferredCurrent,
    deferredNoncurrent: o.deferredNoncurrent ?? A.deferredNoncurrent,
    commissionExpense: t.expenseAccount ?? A.commissionExpense,
    amortizationExpense: t.amortizationAccount ?? A.amortizationExpense,
    impairmentExpense: o.impairmentExpense ?? A.impairmentExpense,
    accruedCommissions: o.accruedCommissions ?? A.accruedCommissions,
  };
}

const Acct = ({ a }: { a: GlAccount }) => (
  <>
    <span className="mr-1 font-mono text-[11px] text-slate-400">{a.number}</span>
    {a.name}
  </>
);
const TreatmentBadge = ({ treatment }: { treatment: string }) => (
  <span className={`rounded px-1.5 py-0.5 text-[10px] ${treatment === 'expense' ? 'bg-rose-100 text-rose-700' : 'bg-emerald-100 text-emerald-700'}`}>
    {treatment === 'expense' ? 'Expense immediately' : 'Capitalize and amortize'}
  </span>
);

type AccountKey = 'deferredCurrent' | 'deferredNoncurrent' | 'commissionExpense' | 'amortizationExpense' | 'impairmentExpense' | 'accruedCommissions';
const ACCOUNT_ROWS: { key: AccountKey; label: string; help: string; capitalizeOnly?: boolean; expenseOnly?: boolean }[] = [
  { key: 'deferredNoncurrent', label: 'Deferred commissions account (non-current)', help: 'Debited when a commission is capitalized', capitalizeOnly: true },
  { key: 'deferredCurrent', label: 'Deferred commissions account (current)', help: 'The next 12 months, moved here by the monthly reclass', capitalizeOnly: true },
  { key: 'amortizationExpense', label: 'Amortization expense account', help: 'Debited each month by department', capitalizeOnly: true },
  { key: 'impairmentExpense', label: 'Write-off expense account', help: 'Debited when an amortization is written off', capitalizeOnly: true },
  { key: 'commissionExpense', label: 'Commission expense account', help: 'Debited for commissions that are expensed' },
  { key: 'accruedCommissions', label: 'Accrued commissions account', help: 'Credited when commissions are accrued for payroll' },
];

/** A field that shows its value, or its input while editing. Module-level so inputs keep focus. */
function F({ label, view, edit, editing }: { label: string; view: ReactNode; edit: ReactNode; editing: boolean }) {
  return <Field label={label}>{editing ? edit : view}</Field>;
}

function TypeRecord({
  ctx,
  type,
  editing,
  onEdit,
  onBack,
  onSaved,
}: {
  ctx: Ctx;
  type: AmortizationTypeRow | null;
  editing: boolean;
  onEdit: (editing: boolean) => void;
  onBack: () => void;
  onSaved: (d: AmortizationTypesPayload, id: string | null) => void;
}) {
  const { data, methods, settings } = ctx;
  const [draft, setDraft] = useState<AmortizationTypeInput>(type ? toInput(type) : emptyType());
  const [error, setError] = useState<string | null>(null);
  const t = editing ? draft : type ? toInput(type) : draft;
  const set = (patch: Partial<AmortizationTypeInput>) => setDraft((d) => ({ ...d, ...patch }));
  const method = methods.find((m) => m.id === (t.methodId ?? settings.defaultMethodId)) ?? null;
  const defaultMethod = methods.find((m) => m.id === settings.defaultMethodId) ?? null;
  const A = accountsFor(t, settings);
  const capitalize = t.treatment === 'capitalize';
  const roleOwner = (roleId: string) => data.types.find((x) => x.id !== type?.id && x.employeeTypes.some((e) => e.id === roleId));

  const overrideOf = (key: AccountKey): GlAccount | null =>
    key === 'commissionExpense' ? t.expenseAccount : key === 'amortizationExpense' ? t.amortizationAccount : (t.accounts?.[key as keyof TypeAccountOverrides] ?? null);
  const setOverride = (key: AccountKey, v: GlAccount | null) => {
    if (key === 'commissionExpense') return set({ expenseAccount: v });
    if (key === 'amortizationExpense') return set({ amortizationAccount: v });
    const next = { ...(draft.accounts ?? {}) };
    if (v) next[key] = v;
    else delete next[key];
    set({ accounts: next });
  };

  const save = async () => {
    try {
      const body = { ...draft, name: draft.name.trim(), description: draft.description?.trim() || null };
      const d = type ? await api.updateAmortizationType(type.id, body) : await api.createAmortizationType(body);
      onSaved(d, type?.id ?? d.types.find((x) => x.name === body.name)?.id ?? null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const remove = async () => {
    if (!type || !window.confirm(`Delete "${type.name}"? Its roles fall back to their own treatment and the default method. The register keeps what it already booked.`)) return;
    try {
      onSaved(await api.deleteAmortizationType(type.id), null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="flex h-full flex-col overflow-auto pb-8">
      <div className="border-b border-slate-200 px-6 py-4">
        <div className="text-xs text-slate-400">
          <button className="hover:underline" onClick={onBack}>
            Amortization Types
          </button>
        </div>
        <div className="text-lg font-semibold">Amortization Type</div>
        <div className="flex items-center gap-2 text-slate-500">
          <span className="text-base">{type ? (editing ? draft.name || type.name : type.name) : 'New type'}</span>
          {type?.inactive && <span className="rounded bg-slate-100 px-1.5 text-[10px]">Inactive</span>}
        </div>
        <div className="mt-3 flex gap-2">
          {editing ? (
            <>
              <button className="btn btn-sm btn-primary" disabled={!draft.name.trim()} onClick={save}>
                Save
              </button>
              <button className="btn btn-sm" onClick={() => (type ? (setDraft(toInput(type)), onEdit(false)) : onBack())}>
                Cancel
              </button>
              {type && (
                <button className="btn btn-sm text-rose-700" onClick={remove}>
                  Delete
                </button>
              )}
            </>
          ) : (
            <>
              <button className="btn btn-sm btn-primary" onClick={() => (setDraft(toInput(type!)), onEdit(true))}>
                Edit
              </button>
              <button className="btn btn-sm" onClick={onBack}>
                Back
              </button>
            </>
          )}
        </div>
      </div>
      <ErrorBar error={error} onDismiss={() => setError(null)} />

      <Section title="Primary Information">
        <F editing={editing} label="Name" view={t.name} edit={<input className="input mt-1 w-full" autoFocus placeholder="Account Executives" value={draft.name} onChange={(e) => set({ name: e.target.value })} />} />
        <F editing={editing}
          label="Treatment"
          view={<TreatmentBadge treatment={t.treatment} />}
          edit={
            <select className="select mt-1 w-full" value={draft.treatment} onChange={(e) => set({ treatment: e.target.value as 'capitalize' | 'expense' })}>
              <option value="capitalize">Capitalize and amortize</option>
              <option value="expense">Expense immediately</option>
            </select>
          }
        />
        <F editing={editing}
          label="Status"
          view={t.inactive ? 'Inactive' : 'Active'}
          edit={
            <label className="mt-1 flex items-center gap-2 text-xs">
              <input type="checkbox" checked={draft.inactive} onChange={(e) => set({ inactive: e.target.checked })} /> Inactive
            </label>
          }
        />
        {capitalize && (
          <>
            <F editing={editing}
              label="Default amortization method"
              view={
                <>
                  {method?.name ?? '—'}
                  {!t.methodId && <span className="ml-1 text-xs text-slate-400">(company default)</span>}
                </>
              }
              edit={
                <select className="select mt-1 w-full" value={draft.methodId ?? ''} onChange={(e) => set({ methodId: e.target.value || null })}>
                  <option value="">Company default{defaultMethod ? `: ${defaultMethod.name}` : ''}</option>
                  {methods
                    .filter((m) => m.def.kind !== 'immediate')
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                </select>
              }
            />
            <F editing={editing}
              label="Default term (months)"
              view={
                <>
                  {t.defaultTermMonths ?? settings.defaultTermMonths}
                  {!t.defaultTermMonths && <span className="ml-1 text-xs text-slate-400">(company default)</span>}
                </>
              }
              edit={
                <input
                  type="number"
                  min={1}
                  className="input mt-1 w-full"
                  placeholder={`Company default: ${settings.defaultTermMonths}`}
                  value={draft.defaultTermMonths ?? ''}
                  onChange={(e) => set({ defaultTermMonths: e.target.value ? Math.max(1, Math.round(Number(e.target.value))) : null })}
                />
              }
            />
            <Field label="Amortization starts">{method ? START_LABEL[method.def.startBasis] : '—'}</Field>
            <div className="col-span-3 -mt-1 text-[11px] text-slate-400">
              {method ? describeMethod(method.def) : ''} The default term is used when a deal has no contract term.
            </div>
          </>
        )}
        <div className="col-span-3">
          <F editing={editing}
            label="Why this treatment"
            view={t.description || <span className="text-slate-400">Add the reasoning here; it is kept as audit support for the policy.</span>}
            edit={
              <textarea
                className="input mt-1 block h-16 w-full"
                placeholder="e.g. Paid only when a contract is signed, so incremental under ASC 340-40-25-1"
                value={draft.description ?? ''}
                onChange={(e) => set({ description: e.target.value })}
              />
            }
          />
        </div>
      </Section>

      <Section title="Account Information">
        {ACCOUNT_ROWS.filter((r) => (capitalize ? true : !r.capitalizeOnly)).map((r) => {
          const own = overrideOf(r.key);
          return (
            <Field key={r.key} label={r.label}>
              {editing ? (
                <div className="mt-1 space-y-1">
                  <label className="flex items-center gap-1.5 text-[11px] text-slate-500">
                    <input type="checkbox" checked={!own} onChange={(e) => setOverride(r.key, e.target.checked ? null : { ...settings.accounts[r.key] })} />
                    Use the company account ({settings.accounts[r.key].number})
                  </label>
                  {own && (
                    <div className="flex gap-1">
                      <input className="input w-20 font-mono" value={own.number} onChange={(e) => setOverride(r.key, { ...own, number: e.target.value })} />
                      <input className="input min-w-0 flex-1" value={own.name} onChange={(e) => setOverride(r.key, { ...own, name: e.target.value })} />
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <Acct a={A[r.key]} />
                  {!own && <span className="ml-1 text-[11px] text-slate-400">(company)</span>}
                </>
              )}
              <div className="text-[11px] text-slate-400">{r.help}</div>
            </Field>
          );
        })}
      </Section>
      {capitalize && <div className="mx-6 mt-2 px-3 text-[11px] text-slate-400">Company accounts are set in Accounting Settings. A type's deferred accounts apply to amortizations booked after you change them; earlier ones stay in the accounts they were booked to.</div>}

      <Section title="Roles">
        <div className="col-span-3">
          {editing ? (
            <div className="grid grid-cols-3 gap-1">
              {data.employeeTypes.map((e) => {
                const owner = roleOwner(e.id);
                const checked = draft.employeeTypeIds?.includes(e.id) ?? false;
                return (
                  <label key={e.id} className="flex items-center gap-2 rounded px-2 py-1 text-xs text-slate-700 hover:bg-slate-100">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(ev) => set({ employeeTypeIds: ev.target.checked ? [...(draft.employeeTypeIds ?? []), e.id] : (draft.employeeTypeIds ?? []).filter((x) => x !== e.id) })}
                    />
                    <span className="flex-1">{e.name}</span>
                    {owner && !checked && <span className="text-[10px] text-slate-400">now: {owner.name}</span>}
                  </label>
                );
              })}
              {data.employeeTypes.length === 0 && <div className="text-xs text-slate-400">No employee types yet. Add them under Employees › Employee types.</div>}
            </div>
          ) : (
            <div className="text-sm">{type?.employeeTypes.length ? type.employeeTypes.map((e) => e.name).join(', ') : <span className="text-slate-400">No roles. Edit to add employee types.</span>}</div>
          )}
          <div className="mt-1 text-[11px] text-slate-400">Each employee type belongs to one amortization type; checking a role moves it here. Changes apply from the next monthly close.</div>
        </div>
      </Section>

      {type && (
        <Section title="Usage">
          <Field label="Amortizations with a balance">{type.usage.count}</Field>
          <Field label={`Balance${data.asOf ? ` at ${monthLabel(data.asOf)}` : ''}`}>{money(type.usage.balance)}</Field>
          <Field label="Last updated">{new Date(type.updatedAt).toLocaleString()}</Field>
        </Section>
      )}
    </div>
  );
}
