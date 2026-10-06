import { useCallback, useEffect, useState } from 'react';
import { api, type CompPlan, type EmployeeType, type EmployeeTypeInput } from '../api';
import { PlanAssignmentsEditor } from './PlanAssignmentsEditor';

const empty = (): EmployeeTypeInput => ({ name: '', description: '', defaultBaseSalary: null, defaultQuota: null });

function parseMoney(s: string): number | null {
  const t = s.trim().replace(/[$,\s]/g, '');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function EmployeeTypesView() {
  const [types, setTypes] = useState<EmployeeType[]>([]);
  const [plans, setPlans] = useState<CompPlan[]>([]);
  const [selectedId, setSelectedId] = useState<string | 'new' | null>(null);
  const [draft, setDraft] = useState<EmployeeTypeInput>(empty());
  const [salaryText, setSalaryText] = useState('');
  const [quotaText, setQuotaText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    const [t, p] = await Promise.all([api.listEmployeeTypes(), api.listPlans()]);
    setTypes(t);
    setPlans(p);
    return t;
  }, []);

  useEffect(() => {
    refresh()
      .then((t) => (t.length ? select(t[0]) : select('new')))
      .catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const select = (t: EmployeeType | 'new') => {
    if (t === 'new') {
      setSelectedId('new');
      setDraft(empty());
      setSalaryText('');
      setQuotaText('');
      return;
    }
    setSelectedId(t.id);
    setDraft({ name: t.name, description: t.description ?? '', defaultBaseSalary: t.defaultBaseSalary, defaultQuota: t.defaultQuota });
    setSalaryText(t.defaultBaseSalary == null ? '' : String(t.defaultBaseSalary));
    setQuotaText(t.defaultQuota == null ? '' : String(t.defaultQuota));
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const body: EmployeeTypeInput = { ...draft, description: draft.description || null, defaultBaseSalary: parseMoney(salaryText), defaultQuota: parseMoney(quotaText) };
      const saved = selectedId === 'new' || !selectedId ? await api.createEmployeeType(body) : await api.updateEmployeeType(selectedId, body);
      const list = await refresh();
      select(list.find((t) => t.id === saved.id) ?? saved);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!selectedId || selectedId === 'new') return;
    const t = types.find((x) => x.id === selectedId);
    if (!t || !window.confirm(`Delete type "${t.name}"? ${t.employeeCount} employee(s) will keep their own settings but lose the type's plans.`)) return;
    await api.deleteEmployeeType(selectedId);
    const list = await refresh();
    if (list.length) select(list[0]);
    else select('new');
  };

  const current = types.find((t) => t.id === selectedId);

  return (
    <div className="flex h-full">
      <aside className="flex w-64 shrink-0 flex-col border-r border-slate-200 bg-white">
        <div className="flex items-center border-b border-slate-200 px-3 py-2">
          <span className="text-sm font-semibold">Employee types</span>
          <div className="flex-1" />
          <button className="btn btn-sm btn-primary" onClick={() => select('new')}>
            + New
          </button>
        </div>
        <div className="flex-1 overflow-auto p-2">
          {types.map((t) => (
            <button
              key={t.id}
              onClick={() => select(t)}
              className={`block w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-slate-100 ${selectedId === t.id ? 'bg-indigo-50 text-indigo-700' : 'text-slate-700'}`}
            >
              <div className="truncate font-medium">{t.name}</div>
              <div className="truncate text-xs text-slate-400">
                {t.employeeCount} employee{t.employeeCount === 1 ? '' : 's'} · {t.assignments.length ? t.assignments.map((a) => a.planName).join(' + ') : 'no plans'}
              </div>
            </button>
          ))}
          {types.length === 0 && <div className="px-2 py-4 text-xs text-slate-400">No types yet — e.g. Enterprise AE, SDR, Account Manager.</div>}
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
              <h2 className="text-base font-semibold">{selectedId === 'new' ? 'New employee type' : draft.name || 'Employee type'}</h2>
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
            <p className="text-xs text-slate-500">
              A type is a role. Its plans apply to every employee of that type; defaults fill in where an employee has no value of their own. Employees can override any of it.
            </p>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <label className="col-span-2 text-slate-600">
                Name
                <input className="input mt-1 block w-full" placeholder="Enterprise AE" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </label>
              <label className="col-span-2 text-slate-600">
                Description
                <input className="input mt-1 block w-full" value={draft.description ?? ''} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
              </label>
              <label className="text-slate-600">
                Default base salary <span className="text-slate-400">(annual)</span>
                <input className="input mt-1 block w-full" placeholder="$90,000" value={salaryText} onChange={(e) => setSalaryText(e.target.value)} />
              </label>
              <label className="text-slate-600">
                Default quota <span className="text-slate-400">(overrides plan.quota)</span>
                <input className="input mt-1 block w-full" placeholder="$500,000" value={quotaText} onChange={(e) => setQuotaText(e.target.value)} />
              </label>
            </div>
          </section>

          {current && (
            <PlanAssignmentsEditor
              title={`Plans for every ${current.name}`}
              hint={
                <>
                  The core plan goes in slot <code>plan</code>; extras (a SPIFF, an override) in their own slots. An employee's own assignment in the same slot replaces the type's.
                </>
              }
              assignments={current.assignments}
              plans={plans}
              onAdd={(b) => api.addTypeAssignment(current.id, b).then(refresh)}
              onUpdate={(id, b) => api.updateTypeAssignment(id, b).then(refresh)}
              onDelete={(id) => api.deleteTypeAssignment(id).then(refresh)}
              onError={setError}
            />
          )}
          {selectedId === 'new' && <p className="text-xs text-slate-400">Save the type first, then add its plans.</p>}
        </div>
      </div>
    </div>
  );
}
