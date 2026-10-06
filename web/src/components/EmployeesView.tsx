import { scopeKey } from '@commissions/shared';
import { useCallback, useEffect, useState } from 'react';
import { EMPLOYEE_STATUSES, STATUS_LABELS, api, type CompPlan, type Employee, type EmployeeInput, type EmployeeType, type ImportSummary } from '../api';
import { PlanAssignmentsEditor } from './PlanAssignmentsEditor';

const emptyInput = (): EmployeeInput => ({
  name: '',
  title: '',
  email: '',
  employeeTypeId: null,
  baseSalary: null,
  quota: null,
  bonuses: [],
  notes: '',
  startDate: null,
  status: 'active',
  statusDate: null,
});

const STATUS_STYLE: Record<string, string> = {
  active: 'bg-emerald-100 text-emerald-800',
  terminated: 'bg-rose-100 text-rose-800',
  inactive: 'bg-slate-200 text-slate-600',
};
const statusStyle = (s: string) => STATUS_STYLE[s] ?? 'bg-amber-100 text-amber-800';

function parseMoney(s: string): number | null {
  const t = s.trim().replace(/[$,\s]/g, '');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

const money = (n: number | null | undefined) => (n == null ? '' : n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }));

export function EmployeesView() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [types, setTypes] = useState<EmployeeType[]>([]);
  const [plans, setPlans] = useState<CompPlan[]>([]);
  const [selectedId, setSelectedId] = useState<string | 'new' | null>(null);
  const [draft, setDraft] = useState<EmployeeInput>(emptyInput());
  const [salaryText, setSalaryText] = useState('');
  const [quotaText, setQuotaText] = useState('');
  const [bonusRows, setBonusRows] = useState<{ label: string; amount: string }[]>([]);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    const [e, t, p] = await Promise.all([api.listEmployees(), api.listEmployeeTypes(), api.listPlans()]);
    setEmployees(e);
    setTypes(t);
    setPlans(p);
    return e;
  }, []);

  useEffect(() => {
    refresh()
      .then((e) => (e.length ? select(e[0]) : select('new')))
      .catch((err) => setError(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const select = (e: Employee | 'new') => {
    if (e === 'new') {
      setSelectedId('new');
      setDraft(emptyInput());
      setSalaryText('');
      setQuotaText('');
      setBonusRows([]);
      return;
    }
    setSelectedId(e.id);
    setDraft({
      name: e.name,
      title: e.title ?? '',
      email: e.email ?? '',
      employeeTypeId: e.employeeTypeId,
      baseSalary: e.baseSalary,
      quota: e.quota,
      bonuses: e.bonuses,
      notes: e.notes ?? '',
      startDate: e.startDate,
      status: e.status ?? 'active',
      statusDate: e.statusDate,
    });
    setSalaryText(e.baseSalary == null ? '' : String(e.baseSalary));
    setQuotaText(e.quota == null ? '' : String(e.quota));
    setBonusRows(e.bonuses.map((b) => ({ label: b.label, amount: String(b.amount) })));
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const body: EmployeeInput = {
        ...draft,
        title: draft.title || null,
        email: draft.email || null,
        notes: draft.notes || null,
        baseSalary: parseMoney(salaryText),
        quota: parseMoney(quotaText),
        bonuses: bonusRows.filter((b) => b.label.trim()).map((b) => ({ label: b.label.trim(), amount: parseMoney(b.amount) ?? 0 })),
      };
      const saved = selectedId === 'new' || !selectedId ? await api.createEmployee(body) : await api.updateEmployee(selectedId, body);
      const list = await refresh();
      select(list.find((e) => e.id === saved.id) ?? saved);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!selectedId || selectedId === 'new') return;
    const e = employees.find((x) => x.id === selectedId);
    if (!e || !window.confirm(`Delete ${e.name} and their plan assignments?`)) return;
    await api.deleteEmployee(selectedId);
    const list = await refresh();
    if (list.length) select(list[0]);
    else select('new');
  };

  const current = employees.find((e) => e.id === selectedId);
  const type = types.find((t) => t.id === draft.employeeTypeId);
  const visible = employees.filter((e) => !search || `${e.name} ${e.typeName ?? ''}`.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="flex h-full">
      <aside className="flex w-64 shrink-0 flex-col border-r border-slate-200 bg-white">
        <div className="flex items-center border-b border-slate-200 px-3 py-2">
          <span className="text-sm font-semibold">Employees</span>
          <span className="ml-2 text-xs text-slate-400">{employees.length}</span>
          <div className="flex-1" />
          <button className="btn btn-sm btn-primary" onClick={() => select('new')}>
            + New
          </button>
        </div>
        <div className="border-b border-slate-100 p-2">
          <input className="input w-full" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="flex-1 overflow-auto p-2">
          {visible.map((e) => (
            <button
              key={e.id}
              onClick={() => select(e)}
              className={`block w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-slate-100 ${selectedId === e.id ? 'bg-indigo-50 text-indigo-700' : 'text-slate-700'}`}
            >
              <div className="flex items-center gap-1">
                <span className="truncate font-medium">{e.name}</span>
                {e.status !== 'active' && <span className={`rounded px-1 text-[10px] ${statusStyle(e.status)}`}>{STATUS_LABELS[e.status] ?? e.status}</span>}
              </div>
              <div className="truncate text-xs text-slate-400">
                {e.typeName ?? 'no type'}
                {e.assignments.length ? ` · +${e.assignments.length} own plan${e.assignments.length === 1 ? '' : 's'}` : ''}
                {e.baseSalary != null ? ` · ${money(e.baseSalary)}` : ''}
              </div>
            </button>
          ))}
          {employees.length === 0 && <div className="px-2 py-4 text-xs text-slate-400">No employees yet.</div>}
        </div>
        <ImportEmployees onDone={refresh} onError={setError} existing={employees} types={types} />
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
              <h2 className="text-base font-semibold">{selectedId === 'new' ? 'New employee' : draft.name || 'Employee'}</h2>
              <div className="flex-1" />
              {selectedId !== 'new' && (
                <button className="btn text-rose-600" onClick={remove}>
                  Delete
                </button>
              )}
              <button className="btn btn-primary" disabled={saving || !draft.name.trim()} onClick={save}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <label className="text-slate-600">
                Name <span className="text-slate-400">(exactly as it appears in the data)</span>
                <input className="input mt-1 block w-full" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </label>
              <label className="text-slate-600">
                Employee type <span className="text-slate-400">(employee.type)</span>
                <select className="select mt-1 block w-full" value={draft.employeeTypeId ?? ''} onChange={(e) => setDraft({ ...draft, employeeTypeId: e.target.value || null })}>
                  <option value="">— none —</option>
                  {types.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-slate-600">
                Title
                <input className="input mt-1 block w-full" value={draft.title ?? ''} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
              </label>
              <label className="text-slate-600">
                Email
                <input className="input mt-1 block w-full" value={draft.email ?? ''} onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
              </label>
              <label className="text-slate-600">
                Base salary <span className="text-slate-400">(annual · employee.base_salary)</span>
                <input className="input mt-1 block w-full" placeholder={type?.defaultBaseSalary != null ? `${money(type.defaultBaseSalary)} from ${type.name}` : '$90,000'} value={salaryText} onChange={(e) => setSalaryText(e.target.value)} />
              </label>
              <label className="text-slate-600">
                Quota <span className="text-slate-400">(employee.quota · overrides plan.quota)</span>
                <input className="input mt-1 block w-full" placeholder={type?.defaultQuota != null ? `${money(type.defaultQuota)} from ${type.name}` : 'plan default'} value={quotaText} onChange={(e) => setQuotaText(e.target.value)} />
              </label>
              <label className="text-slate-600">
                Start date
                <input type="date" className="input mt-1 block w-full" value={draft.startDate ?? ''} onChange={(e) => setDraft({ ...draft, startDate: e.target.value || null })} />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="text-slate-600">
                  Status <span className="text-slate-400">(employee.status)</span>
                  <select className="select mt-1 block w-full" value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value as EmployeeInput['status'] })}>
                    {EMPLOYEE_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {STATUS_LABELS[s]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-slate-600">
                  {draft.status === 'terminated' ? 'Termination date' : draft.status === 'active' ? 'Since' : 'Leave started'}
                  <input type="date" className="input mt-1 block w-full" value={draft.statusDate ?? ''} onChange={(e) => setDraft({ ...draft, statusDate: e.target.value || null })} />
                </label>
              </div>
              <label className="col-span-2 text-slate-600">
                Notes
                <input className="input mt-1 block w-full" value={draft.notes ?? ''} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
              </label>
            </div>

            <div>
              <div className="mb-1 flex items-center text-xs">
                <span className="font-semibold text-slate-600">Bonuses</span>
                <span className="ml-2 text-slate-400">
                  fixed amounts, available as <code>employee.&lt;label&gt;</code> and <code>employee.bonus_total</code>
                </span>
                <div className="flex-1" />
                <button className="btn btn-sm" onClick={() => setBonusRows([...bonusRows, { label: '', amount: '' }])}>
                  + Bonus
                </button>
              </div>
              <div className="space-y-1 text-xs">
                {bonusRows.map((b, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input className="input w-48" placeholder="Car allowance" value={b.label} onChange={(e) => setBonusRows(bonusRows.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
                    <input className="input w-32" placeholder="$6,000" value={b.amount} onChange={(e) => setBonusRows(bonusRows.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
                    {b.label.trim() && <span className="font-mono text-slate-400">employee.{scopeKey(b.label)}</span>}
                    <div className="flex-1" />
                    <button className="text-slate-400 hover:text-rose-600" onClick={() => setBonusRows(bonusRows.filter((_, j) => j !== i))}>
                      ✕
                    </button>
                  </div>
                ))}
                {bonusRows.length === 0 && <div className="text-slate-400">No bonuses.</div>}
              </div>
            </div>
          </section>

          {current && (
            <PlanAssignmentsEditor
              title="Plans"
              hint={
                <>
                  Plans from the employee type are shown greyed. Add a plan here to override a slot for this person only (e.g. a special SPIFF, or a different core plan). Formulas use{' '}
                  <code>plan.rate</code> / <code>TIER(x)</code> for slot <code>plan</code> and <code>spiff.rate</code> / <code>TIER(x, "spiff")</code> for slot <code>spiff</code>.
                </>
              }
              assignments={current.assignments}
              inherited={current.inherited ?? []}
              plans={plans}
              onAdd={(b) => api.addAssignment(current.id, b).then(refresh)}
              onUpdate={(id, b) => api.updateAssignment(id, b).then(refresh)}
              onDelete={(id) => api.deleteAssignment(id).then(refresh)}
              onError={setError}
            />
          )}
          {selectedId === 'new' && <p className="text-xs text-slate-400">Save the employee first, then add any plans beyond what their type provides.</p>}
        </div>
      </div>
    </div>
  );
}

// -- Bulk import from an import column ---------------------------------------

function ImportEmployees({ onDone, onError, existing, types }: { onDone: () => Promise<unknown>; onError: (m: string) => void; existing: Employee[]; types: EmployeeType[] }) {
  const [open, setOpen] = useState(false);
  const [imports, setImports] = useState<ImportSummary[]>([]);
  const [pickImport, setPickImport] = useState('');
  const [columns, setColumns] = useState<string[]>([]);
  const [pickColumn, setPickColumn] = useState('');
  const [typeId, setTypeId] = useState('');
  const [candidates, setCandidates] = useState<{ value: string; count: number }[]>([]);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const have = new Set(existing.map((e) => e.name.toLowerCase()));

  useEffect(() => {
    if (open) api.listImports().then(setImports).catch(() => {});
  }, [open]);
  useEffect(() => {
    if (!pickImport) return;
    api.getImport(pickImport).then((imp) => {
      const names = imp.columns.map((c) => c.name);
      setColumns(names);
      setPickColumn(names.find((n) => /rep|owner|sales|employee|name/i.test(n)) ?? names[0] ?? '');
    });
  }, [pickImport]);
  useEffect(() => {
    if (!pickImport || !pickColumn) return;
    api.values(pickImport, { field: pickColumn, limit: 500 }).then((r) => {
      setCandidates(r.values.filter((v) => v.value !== ''));
      setTicked(new Set());
    });
  }, [pickImport, pickColumn]);

  if (!open) {
    return (
      <div className="border-t border-slate-200 p-2">
        <button className="btn btn-sm w-full" onClick={() => setOpen(true)}>
          Add from an import…
        </button>
      </div>
    );
  }
  const missing = candidates.filter((c) => !have.has(c.value.toLowerCase()));
  return (
    <div className="space-y-2 border-t border-slate-200 p-2 text-xs">
      <div className="flex items-center">
        <span className="font-semibold text-slate-600">Add from an import</span>
        <div className="flex-1" />
        <button className="text-slate-400 hover:text-slate-700" onClick={() => setOpen(false)}>
          ✕
        </button>
      </div>
      <select className="select w-full" value={pickImport} onChange={(e) => setPickImport(e.target.value)}>
        <option value="">— import —</option>
        {imports.map((i) => (
          <option key={i.id} value={i.id}>
            {i.name}
          </option>
        ))}
      </select>
      <select className="select w-full" value={pickColumn} onChange={(e) => setPickColumn(e.target.value)} disabled={!pickImport}>
        {columns.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      <select className="select w-full" value={typeId} onChange={(e) => setTypeId(e.target.value)} title="Employee type to give the new people">
        <option value="">— no type —</option>
        {types.map((t) => (
          <option key={t.id} value={t.id}>
            as {t.name}
          </option>
        ))}
      </select>
      <div className="max-h-40 overflow-auto">
        {missing.map((c) => (
          <label key={c.value} className="flex items-center gap-2 py-0.5">
            <input
              type="checkbox"
              checked={ticked.has(c.value)}
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
            <span className="text-slate-400">{c.count}</span>
          </label>
        ))}
        {pickImport && missing.length === 0 && <div className="py-1 text-slate-400">Everyone in this column already exists.</div>}
      </div>
      <div className="flex gap-1">
        <button className="btn btn-sm" disabled={!missing.length} onClick={() => setTicked(new Set(missing.map((m) => m.value)))}>
          All
        </button>
        <button
          className="btn btn-sm btn-primary flex-1"
          disabled={!ticked.size}
          onClick={async () => {
            try {
              await api.bulkCreateEmployees([...ticked], typeId || null);
              setTicked(new Set());
              await onDone();
            } catch (e) {
              onError((e as Error).message);
            }
          }}
        >
          Add {ticked.size || ''}
        </button>
      </div>
    </div>
  );
}
