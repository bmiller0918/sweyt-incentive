import { useState } from 'react';
import type { CompPlan } from '../api';
import { PeriodPicker } from './PeriodPicker';

export interface AssignmentRow {
  id: string;
  compPlanId: string;
  planName: string;
  slot: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
}

interface Props {
  title: string;
  hint?: React.ReactNode;
  assignments: AssignmentRow[];
  /** Read-only rows shown greyed (e.g. inherited from the employee's type). */
  inherited?: AssignmentRow[];
  plans: CompPlan[];
  onAdd: (body: { compPlanId: string; slot: string }) => Promise<unknown>;
  onUpdate: (id: string, body: { compPlanId: string; slot: string; effectiveFrom: string | null; effectiveTo: string | null }) => Promise<unknown>;
  onDelete: (id: string) => Promise<unknown>;
  onError: (m: string) => void;
}

const SLOT_SUGGESTIONS = ['plan', 'spiff', 'bonus', 'override'];

/** Slot / plan / effective-date table used by both employee types and employees. */
export function PlanAssignmentsEditor({ title, hint, assignments, inherited = [], plans, onAdd, onUpdate, onDelete, onError }: Props) {
  const [planId, setPlanId] = useState('');
  const [slot, setSlot] = useState('plan');
  const own = new Set(assignments.map((a) => a.slot));
  const shadowed = (s: string) => own.has(s);

  const run = (p: Promise<unknown>) => p.catch((e: Error) => onError(e.message));

  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">
        {title} <span className="font-normal text-slate-400">({assignments.length})</span>
      </h3>
      {hint && <p className="text-xs text-slate-500">{hint}</p>}
      <table className="w-full text-xs">
        <thead className="text-left text-slate-400">
          <tr>
            <th className="py-1 font-normal">Slot</th>
            <th className="py-1 font-normal">Plan</th>
            <th className="py-1 font-normal">Effective period</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {inherited.map((a) => (
            <tr key={`inh-${a.id}`} className={`border-t border-slate-100 ${shadowed(a.slot) ? 'text-slate-300 line-through' : 'text-slate-500'}`} title={shadowed(a.slot) ? 'Overridden by this employee’s own assignment in the same slot' : 'Inherited from the employee type'}>
              <td className="py-1 pr-2 font-mono">{a.slot}</td>
              <td className="py-1 pr-2">
                {a.planName} <span className="rounded bg-slate-100 px-1 text-[10px] no-underline">from type</span>
              </td>
              <td className="py-1 pr-2 whitespace-nowrap">
                {a.effectiveFrom ?? '…'} → {a.effectiveTo ?? '…'}
              </td>
              <td />
            </tr>
          ))}
          {assignments.map((a) => (
            <tr key={a.id} className="border-t border-slate-100">
              <td className="py-1 pr-2">
                <input className="input w-24 font-mono" list="slot-suggestions" value={a.slot} onChange={(e) => run(onUpdate(a.id, { ...a, slot: e.target.value || 'plan' }))} />
              </td>
              <td className="py-1 pr-2">
                <select className="select" value={a.compPlanId} onChange={(e) => run(onUpdate(a.id, { ...a, compPlanId: e.target.value }))}>
                  {plans.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </td>
              <td className="py-1 pr-2">
                <PeriodPicker compact from={a.effectiveFrom} to={a.effectiveTo} onChange={(effectiveFrom, effectiveTo) => run(onUpdate(a.id, { ...a, effectiveFrom, effectiveTo }))} />
              </td>
              <td className="py-1 text-right">
                <button className="text-slate-400 hover:text-rose-600" onClick={() => run(onDelete(a.id))}>
                  ✕
                </button>
              </td>
            </tr>
          ))}
          {assignments.length === 0 && inherited.length === 0 && (
            <tr>
              <td colSpan={4} className="py-2 text-slate-400">
                No plans assigned.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <datalist id="slot-suggestions">
        {SLOT_SUGGESTIONS.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white p-2 text-xs">
        <span className="text-slate-500">Add plan:</span>
        <select className="select" value={planId} onChange={(e) => setPlanId(e.target.value)}>
          <option value="">— choose a plan —</option>
          {plans.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <span className="text-slate-500">as</span>
        <input className="input w-24 font-mono" list="slot-suggestions" value={slot} onChange={(e) => setSlot(e.target.value)} />
        {own.has(slot.trim().toLowerCase()) && <span className="text-amber-700">slot already used — the newest effective assignment wins</span>}
        <button
          className="btn btn-sm"
          disabled={!planId}
          onClick={() =>
            run(onAdd({ compPlanId: planId, slot: slot.trim() || 'plan' })).then(() => {
              setPlanId('');
            })
          }
        >
          Add
        </button>
        {plans.length === 0 && <span className="text-amber-700">Create a comp plan first.</span>}
      </div>
    </section>
  );
}
