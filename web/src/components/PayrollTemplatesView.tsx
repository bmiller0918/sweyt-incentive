import {
  CREDITING,
  CREDITING_HINTS,
  CREDITING_LABELS,
  OPERATOR_LABELS,
  componentKey,
  emptyTemplateDefinition,
  familyOf,
  operandArity,
  templateProblems,
  type ColumnType,
  type Condition,
  type Crediting,
  type HoldRule,
  type Operator,
  type PayrollTemplateDefinition,
} from '@commissions/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type CompPlan, type EmployeeType, type HoldReason, type PayrollTemplate, type PayrollTemplateInput, type RuleField } from '../api';

/**
 * Commission payroll templates: one per employee type, saying who is paid on
 * each deal in the data you import (their own deals, or all deals) and which
 * columns the run reads. A register of templates, and a record to edit one.
 */

/** Operators offered in the hold-rule editor, by column family. Enough for the usual "box not ticked" checks. */
const RULE_OPERATORS: Record<ReturnType<typeof familyOf>, Operator[]> = {
  text: ['is', 'is_not', 'contains', 'not_contains', 'empty', 'not_empty'],
  number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'empty', 'not_empty'],
  date: ['before', 'after', 'on_or_before', 'on_or_after', 'empty', 'not_empty'],
  boolean: ['is_true', 'is_false', 'empty', 'not_empty'],
};

const newRule = (reasonKey: string, field: string): HoldRule => ({
  id: `r${Math.random().toString(36).slice(2, 8)}`,
  reasonKey,
  condition: { type: 'condition', id: `c${Math.random().toString(36).slice(2, 8)}`, field, operator: 'is', values: [{ kind: 'literal', value: '' }] },
});

const isNum = (t: ColumnType) => ['currency', 'decimal', 'integer', 'percent'].includes(t);
const isDate = (t: ColumnType) => t === 'date' || t === 'datetime';

/** Sensible starting point for a type: SEs and SCs are usually paid across all deals; SDRs on the deals they sourced. */
function guessFor(typeName: string, fields: RuleField[]): Pick<PayrollTemplateDefinition, 'crediting' | 'creditField' | 'amountField' | 'dateField' | 'dealKeyField'> {
  const names = fields.map((f) => f.name);
  const find = (re: RegExp, type?: (t: ColumnType) => boolean) => fields.find((f) => re.test(f.name) && (!type || type(f.type)))?.name ?? '';
  const pooled = /\b(se|sc|sales engineer|solutions?|consultant|presales)\b/i.test(typeName);
  const sdr = /\b(sdr|bdr|development)\b/i.test(typeName);
  const creditField = sdr ? find(/\b(sdr|bdr)\b|source|set by|booked by/i) : find(new RegExp(`\\b${typeName.replace(/[^a-z0-9 ]/gi, '')}\\b`, 'i')) || find(/\b(owner|rep|ae|salesperson)\b/i);
  return {
    crediting: pooled ? 'all' : 'own',
    creditField: pooled ? '' : creditField,
    amountField: find(/\b(acv|amount|arr|bookings?|value)\b/i, isNum) || (fields.find((f) => isNum(f.type))?.name ?? ''),
    dateField: find(/close|booked|signed/i, isDate) || (fields.find((f) => isDate(f.type))?.name ?? ''),
    dealKeyField: find(/\b(deal|opportunity|opp)\b.*\b(id|number|#)/i) || (names.find((n) => /^id$/i.test(n)) ?? ''),
  };
}

const emptyTemplate = (): PayrollTemplateInput => ({ name: '', description: '', employeeTypeId: null, definition: emptyTemplateDefinition() });

export function PayrollTemplatesView({ onError }: { onError: (m: string | null) => void }) {
  const [templates, setTemplates] = useState<PayrollTemplate[]>([]);
  const [types, setTypes] = useState<EmployeeType[]>([]);
  const [fields, setFields] = useState<RuleField[]>([]);
  const [plans, setPlans] = useState<CompPlan[]>([]);
  const [reasons, setReasons] = useState<HoldReason[]>([]);
  const [openId, setOpenId] = useState<string | 'new' | null>(null);

  const refresh = useCallback(() => api.listPayrollTemplates().then(setTemplates), []);
  useEffect(() => {
    Promise.all([refresh(), api.listEmployeeTypes().then(setTypes), api.listRuleFields().then(setFields), api.listPlans().then(setPlans), api.listHoldReasons().then(setReasons)]).catch((e) => onError(e.message));
  }, [refresh, onError]);

  const typeName = (id: string | null) => (id ? (types.find((t) => t.id === id)?.name ?? 'Deleted type') : '');

  if (openId) {
    const existing = openId === 'new' ? null : (templates.find((t) => t.id === openId) ?? null);
    return (
      <TemplateRecord
        key={openId}
        initial={existing ?? emptyTemplate()}
        id={existing?.id ?? null}
        types={types}
        fields={fields}
        plans={plans}
        reasons={reasons}
        onBack={() => setOpenId(null)}
        onSaved={async (t) => {
          await refresh();
          setOpenId(t.id);
        }}
        onDeleted={async () => {
          await refresh();
          setOpenId(null);
        }}
        onError={onError}
      />
    );
  }

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="mb-3 flex items-center gap-2">
        <div>
          <div className="text-base font-semibold">Payroll templates</div>
          <div className="max-w-3xl text-xs text-slate-500">
            One template per employee type. It says who is paid on each deal in the data you import, and which columns to read. AEs are usually paid on the deals they
            closed, SDRs on the deals they sourced, and SEs or SCs across all deals. Apply templates to an import from the Imports tab.
          </div>
        </div>
        <div className="flex-1" />
        <button className="btn btn-primary" onClick={() => setOpenId('new')}>
          + New template
        </button>
      </div>
      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-panel">
        <table className="w-full text-sm">
          <thead className="bg-slate-100 text-left text-xs font-medium text-slate-600">
            <tr>
              <th className="px-3 py-2">Template</th>
              <th className="px-3 py-2">Employee type</th>
              <th className="px-3 py-2">Paid on</th>
              <th className="px-3 py-2">Amount</th>
              <th className="px-3 py-2">Hold rules</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Updated</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {templates.map((t) => {
              const problems = templateProblems(t.definition, t.employeeTypeId);
              return (
                <tr key={t.id} className="cursor-pointer hover:bg-slate-50" onClick={() => setOpenId(t.id)}>
                  <td className="px-3 py-2 font-medium text-slate-800">{t.name}</td>
                  <td className="px-3 py-2">{typeName(t.employeeTypeId) || <span className="text-slate-400">Any</span>}</td>
                  <td className="px-3 py-2 text-slate-600">
                    {t.definition.crediting === 'all' ? 'All deals' : t.definition.creditField ? `Own deals · ${t.definition.creditField}` : 'Own deals'}
                  </td>
                  <td className="px-3 py-2 text-slate-600">{t.definition.amountField || '—'}</td>
                  <td className="px-3 py-2 text-slate-500">{t.definition.holdRules.length}</td>
                  <td className="px-3 py-2">
                    <span className={`rounded px-1.5 py-0.5 text-[11px] ${problems.length ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800'}`} title={problems.join(' ')}>
                      {problems.length ? 'Incomplete' : 'Ready'}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-500">{new Date(t.updatedAt).toLocaleDateString()}</td>
                </tr>
              );
            })}
            {templates.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-xs text-slate-400">
                  No templates yet. Start with one per employee type you pay, e.g. Account Executive, Sales Engineer and SDR.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TemplateRecord({
  initial,
  id,
  types,
  fields,
  plans,
  reasons,
  onBack,
  onSaved,
  onDeleted,
  onError,
}: {
  initial: PayrollTemplateInput;
  id: string | null;
  types: EmployeeType[];
  fields: RuleField[];
  plans: CompPlan[];
  reasons: HoldReason[];
  onBack: () => void;
  onSaved: (t: PayrollTemplate) => void;
  onDeleted: () => void;
  onError: (m: string | null) => void;
}) {
  const [draft, setDraft] = useState<PayrollTemplateInput>(initial);
  const [saving, setSaving] = useState(false);
  const d = draft.definition;
  const setDef = (patch: Partial<PayrollTemplateDefinition>) => setDraft({ ...draft, definition: { ...d, ...patch } });
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const problems = templateProblems(d, draft.employeeTypeId);

  const textCols = fields.filter((f) => f.type === 'text').map((f) => f.name);
  const numCols = fields.filter((f) => isNum(f.type)).map((f) => f.name);
  const dateCols = fields.filter((f) => isDate(f.type)).map((f) => f.name);
  const allCols = fields.map((f) => f.name);

  /** Component names across the plans this type is on (all plans when no type), one per engine key. */
  const componentNames = useMemo(() => {
    const seen = new Map<string, string>();
    for (const p of plans) {
      if (draft.employeeTypeId && p.employeeTypeId && p.employeeTypeId !== draft.employeeTypeId) continue;
      for (const c of p.structure?.components ?? []) {
        const key = componentKey(c.name);
        if (key && !seen.has(key)) seen.set(key, c.name.trim());
      }
    }
    return [...seen.values()];
  }, [plans, draft.employeeTypeId]);
  const usesMargin = plans.some((p) => p.quotas?.percentOfMargin.applies && (!draft.employeeTypeId || !p.employeeTypeId || p.employeeTypeId === draft.employeeTypeId));

  const pickType = (typeId: string) => {
    const t = types.find((x) => x.id === typeId);
    if (!t) return setDraft({ ...draft, employeeTypeId: null });
    // A fresh template takes its name and columns from the type; an edited one only changes type.
    if (!id && !d.amountField) return setDraft({ ...draft, employeeTypeId: t.id, name: draft.name || `${t.name} payroll`, definition: { ...d, ...guessFor(t.name, fields) } });
    setDraft({ ...draft, employeeTypeId: t.id });
  };

  const save = async () => {
    setSaving(true);
    onError(null);
    try {
      const body = { ...draft, name: draft.name.trim(), description: draft.description?.trim() || null };
      onSaved(id ? await api.updatePayrollTemplate(id, body) : await api.createPayrollTemplate(body));
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!id || !window.confirm(`Delete template "${initial.name}"? Runs already made with it keep their lines.`)) return;
    try {
      await api.deletePayrollTemplate(id);
      onDeleted();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  return (
    <div className="flex-1 overflow-auto">
      <div className="border-b border-slate-200 px-6 py-3">
        <button className="text-xs text-slate-400 hover:text-slate-700" onClick={onBack}>
          ‹ Payroll templates
        </button>
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">{id ? initial.name : 'New payroll template'}</h2>
          {problems.length > 0 && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-800">Incomplete</span>}
          <div className="flex-1" />
          {id && (
            <button className="btn btn-sm text-rose-600" onClick={remove}>
              Delete
            </button>
          )}
          <button className="btn btn-sm" onClick={onBack}>
            {dirty ? 'Cancel' : 'Close'}
          </button>
          <button className="btn btn-sm btn-primary" disabled={saving || !dirty || !draft.name.trim()} onClick={save}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
        {problems.length > 0 && <div className="mt-1 text-xs text-amber-700">{problems.join(' ')}</div>}
      </div>

      <div className="max-w-4xl space-y-6 p-6">
        <div className="grid grid-cols-2 gap-4">
          <label className="block text-sm">
            <span className="text-xs text-slate-500">Employee type</span>
            <select className="select mt-1 w-full" value={draft.employeeTypeId ?? ''} onChange={(e) => pickType(e.target.value)}>
              <option value="">Any type</option>
              {types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-xs text-slate-500">Name</span>
            <input className="input mt-1 w-full" value={draft.name} placeholder="e.g. Account Executive payroll" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <label className="col-span-2 block text-sm">
            <span className="text-xs text-slate-500">Description (optional)</span>
            <input className="input mt-1 w-full" value={draft.description ?? ''} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          </label>
        </div>

        <div>
          <div className="text-xs font-semibold text-slate-600">Who is paid on each deal</div>
          <div className="mt-2 grid grid-cols-2 gap-3">
            {CREDITING.map((c: Crediting) => (
              <label key={c} className={`flex cursor-pointer gap-2 rounded-lg border p-3 text-sm ${d.crediting === c ? 'border-indigo-400 bg-indigo-50' : 'border-slate-200 bg-panel'}`}>
                <input type="radio" className="mt-0.5" checked={d.crediting === c} onChange={() => setDef({ crediting: c })} />
                <span>
                  <span className="font-medium">{CREDITING_LABELS[c]}</span>
                  <span className="block text-xs text-slate-500">{CREDITING_HINTS[c]}</span>
                </span>
              </label>
            ))}
          </div>
          {d.crediting === 'own' ? (
            <div className="mt-3 grid grid-cols-2 gap-3">
              <ColumnField label="Credit column" hint="The column naming the person, e.g. Opportunity Owner or SDR." value={d.creditField} onChange={(v) => setDef({ creditField: v })} options={textCols} required />
            </div>
          ) : (
            <div className="mt-2 text-xs text-slate-500">
              {draft.employeeTypeId
                ? 'Everyone with this employee type who is employed on a deal’s close date gets a line on that deal, under their own plan.'
                : 'Pick an employee type: everyone with that type is paid on every deal.'}
            </div>
          )}
        </div>

        <div>
          <div className="text-xs font-semibold text-slate-600">Deal columns</div>
          <div className="mt-2 grid grid-cols-3 gap-3">
            <ColumnField label="Amount" value={d.amountField} onChange={(v) => setDef({ amountField: v })} options={numCols} required />
            <ColumnField label="Close date" value={d.dateField} onChange={(v) => setDef({ dateField: v })} options={dateCols} />
            <ColumnField label="Deal ID" value={d.dealKeyField} onChange={(v) => setDef({ dealKeyField: v })} options={allCols} />
          </div>
        </div>

        <div>
          <div className="text-xs font-semibold text-slate-600">For amortization</div>
          <div className="mt-1 text-xs text-slate-400">Where the subscription starts and how long it runs, so capitalized commissions amortize over the contract term.</div>
          <div className="mt-2 grid grid-cols-3 gap-3">
            <ColumnField label="Subscription start" value={d.contractStartField} onChange={(v) => setDef({ contractStartField: v })} options={dateCols} />
            <ColumnField label="Term (months)" value={d.termMonthsField} onChange={(v) => setDef({ termMonthsField: v })} options={numCols} />
            <ColumnField label="Or subscription end" value={d.contractEndField} onChange={(v) => setDef({ contractEndField: v })} options={dateCols} />
          </div>
        </div>

        {(usesMargin || d.marginField) && (
          <div>
            <div className="text-xs font-semibold text-slate-600">Margin</div>
            <div className="mt-1 text-xs text-slate-400">Plans with a percent-of-margin quota pay on each deal’s gross profit. Leave it blank and those plans pay nothing on margin.</div>
            <div className="mt-2 grid grid-cols-3 gap-3">
              <ColumnField label="Gross profit" value={d.marginField} onChange={(v) => setDef({ marginField: v })} options={numCols} />
            </div>
          </div>
        )}

        {componentNames.length > 0 && (
          <div>
            <div className="text-xs font-semibold text-slate-600">Plan components</div>
            <div className="mt-1 text-xs text-slate-400">Plans with weighted components pay one line per component from its own column. A component left unmapped pays nothing.</div>
            <div className="mt-2 grid grid-cols-3 gap-3">
              {componentNames.map((n) => {
                const cur = d.components.find((c) => c.name === n)?.field ?? '';
                return (
                  <ColumnField
                    key={n}
                    label={n}
                    value={cur}
                    options={numCols}
                    onChange={(v) => setDef({ components: [...d.components.filter((c) => c.name !== n), ...(v ? [{ name: n, field: v }] : [])] })}
                  />
                );
              })}
            </div>
          </div>
        )}

        <div>
          <div className="flex items-center">
            <span className="text-xs font-semibold text-slate-600">Hold rules</span>
            <div className="flex-1" />
            <button className="btn btn-sm" disabled={!fields.length || !reasons.length} onClick={() => setDef({ holdRules: [...d.holdRules, newRule(reasons[0]?.key ?? 'other', fields[0]?.name ?? '')] })}>
              + Add rule
            </button>
          </div>
          <div className="mt-1 text-xs text-slate-400">
            For this type only: a deal that matches starts on hold with that reason. The workspace payout rules under Payouts › Payout Rules apply first, to every template.
          </div>
          {d.holdRules.map((r, i) => (
            <HoldRuleRow
              key={r.id}
              rule={r}
              columns={fields}
              reasons={reasons}
              onChange={(nr) => setDef({ holdRules: d.holdRules.map((x, j) => (j === i ? nr : x)) })}
              onRemove={() => setDef({ holdRules: d.holdRules.filter((_, j) => j !== i) })}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/** A column picker. Keeps a saved column that no current import has, so opening a template never drops it. */
function ColumnField({ label, value, onChange, options, required, hint }: { label: string; value: string; onChange: (v: string) => void; options: string[]; required?: boolean; hint?: string }) {
  const opts = value && !options.includes(value) ? [value, ...options] : options;
  return (
    <label className="block text-sm" title={hint}>
      <span className="text-xs text-slate-500">
        {label}
        {required ? '' : ' (optional)'}
      </span>
      <select className="select mt-1 w-full" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{required ? 'Pick a column…' : 'None'}</option>
        {opts.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
      {hint && <span className="mt-0.5 block text-[11px] text-slate-400">{hint}</span>}
    </label>
  );
}

function HoldRuleRow({ rule, columns, reasons, onChange, onRemove }: { rule: HoldRule; columns: { name: string; type: ColumnType }[]; reasons: HoldReason[]; onChange: (r: HoldRule) => void; onRemove: () => void }) {
  const col = columns.find((c) => c.name === rule.condition.field);
  const family = col ? familyOf(col.type) : 'text';
  const ops = RULE_OPERATORS[family];
  const cond = rule.condition as Condition;
  const arity = operandArity(cond.operator);
  const setCond = (patch: Partial<Condition>) => onChange({ ...rule, condition: { ...cond, ...patch } });
  const value = cond.values[0]?.kind === 'literal' ? cond.values[0].value : '';
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
      <span className="text-xs text-slate-500">Hold for</span>
      <select className="select" value={rule.reasonKey} onChange={(e) => onChange({ ...rule, reasonKey: e.target.value })}>
        {reasons.map((r) => (
          <option key={r.key} value={r.key}>
            {r.name}
          </option>
        ))}
      </select>
      <span className="text-xs text-slate-500">when</span>
      <select
        className="select"
        value={cond.field}
        onChange={(e) => {
          const c = columns.find((x) => x.name === e.target.value);
          const fam = c ? familyOf(c.type) : 'text';
          setCond({ field: e.target.value, operator: RULE_OPERATORS[fam][0], values: [{ kind: 'literal', value: '' }] });
        }}
      >
        {!col && cond.field && <option value={cond.field}>{cond.field}</option>}
        {columns.map((c) => (
          <option key={c.name} value={c.name}>
            {c.name}
          </option>
        ))}
      </select>
      <select className="select" value={cond.operator} onChange={(e) => setCond({ operator: e.target.value as Operator })}>
        {ops.map((o) => (
          <option key={o} value={o}>
            {OPERATOR_LABELS[o]}
          </option>
        ))}
      </select>
      {arity !== 0 && (
        <input
          type={family === 'date' ? 'date' : family === 'number' ? 'number' : 'text'}
          className="input w-44"
          placeholder="value"
          value={value}
          onChange={(e) => setCond({ values: [{ kind: 'literal', value: e.target.value }] })}
        />
      )}
      <button className="text-slate-400 hover:text-rose-600" onClick={onRemove}>
        ✕
      </button>
    </div>
  );
}
