// One amortization record (AMRT0001): its details, schedule, journals,
// accounts and history, with the actions an accountant takes on it.
import { useCallback, useEffect, useState } from 'react';
import { api, type AmortizationTypeRow, type AssetDetail, type ScheduleState } from '../../api';
import { AmortizationForm } from './AmortizationForm';
import { ErrorBar, Field, Modal, Section, StatusBadge, downloadCsv, money, monthLabel } from './ui';

type Tab = 'schedule' | 'modifications' | 'accounting' | 'notes';
const TABS: { key: Tab; label: string }[] = [
  { key: 'schedule', label: 'Amortization Schedule' },
  { key: 'modifications', label: 'Modifications' },
  { key: 'accounting', label: 'Accounting Information' },
  { key: 'notes', label: 'System Notes' },
];
const STATE_LABEL: Record<ScheduleState, string> = { booked: 'Booked', next_close: 'Next close', scheduled: 'Scheduled', pending: 'Pending' };
const ACTION_LABEL: Record<string, string> = {
  created: 'Created',
  booked: 'Booked',
  unbooked: 'Unbooked',
  modified: 'Modified',
  transferred: 'Transferred',
  written_off: 'Written off',
  write_off_undone: 'Write-off undone',
};
const fmt = (v: string | number | null) => (v === null || v === '' ? '—' : typeof v === 'number' ? v.toLocaleString() : v);
const date = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC' });

export function AmortizationDetailView({ id, onBack, onOpenClose }: { id: string; onBack: () => void; onOpenClose: () => void }) {
  const [a, setA] = useState<AssetDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('schedule');
  const [dialog, setDialog] = useState<'edit' | 'modify' | 'transfer' | 'writeoff' | null>(null);

  const load = useCallback(
    () =>
      api
        .getAsset(id)
        .then(setA)
        .catch((e) => setError(e.message)),
    [id],
  );
  useEffect(() => {
    load();
  }, [load]);

  if (!a) return <div className="p-6 text-sm text-slate-400">{error ?? 'Loading…'}</div>;

  const booked = !!a.bookedMonth;
  const pendingWriteOff = !!(a.writtenOffMonth && a.openMonth && a.writtenOffMonth >= a.openMonth);
  const canModify = booked && !a.writtenOffMonth && a.remaining !== 0;
  const act = async (f: () => Promise<unknown>, after?: () => void) => {
    try {
      await f();
      setDialog(null);
      after ? after() : await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const exportSchedule = () =>
    downloadCsv(
      `${a.code}-schedule.csv`,
      ['ID', 'Name', 'Transaction Type', 'Period', 'Period Start', 'Period End', 'Amount', 'Remaining Balance', 'Journal Entry', 'State'],
      a.schedule.map((s) => [a.code, a.name, s.type, s.period, s.start, s.end, s.amount, s.remaining, s.journal ?? '', STATE_LABEL[s.state]]),
    );
  const modifications = a.history.filter((h) => ['modified', 'transferred', 'written_off', 'write_off_undone'].includes(h.action));

  return (
    <div className="flex h-full flex-col overflow-auto">
      <div className="border-b border-slate-200 px-6 py-4">
        <div className="text-xs text-slate-400">
          <button className="hover:underline" onClick={onBack}>
            Amortization Register
          </button>{' '}
          › {a.origin === 'manual' ? 'Manual amortization' : 'Commission amortization'}
        </div>
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">{a.code}</h1>
          <span className="text-slate-500">{a.name}</span>
          <StatusBadge status={a.status} />
          {pendingWriteOff && <span className="text-xs text-rose-700">Write-off pending {monthLabel(a.writtenOffMonth!)}</span>}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {a.editable && (
            <button className="btn btn-sm btn-primary" onClick={() => setDialog('edit')}>
              Edit
            </button>
          )}
          <button className="btn btn-sm" onClick={onBack}>
            Back
          </button>
          <button className="btn btn-sm" onClick={onOpenClose} title="Journals are booked by the monthly close">
            Run Journals
          </button>
          <button className="btn btn-sm" disabled={!canModify} onClick={() => setDialog('modify')} title={canModify ? 'Rename, or change the end date from the open month on' : 'Only a booked amortization with a balance can be modified'}>
            Modify
          </button>
          {pendingWriteOff ? (
            <button className="btn btn-sm" onClick={() => act(() => api.undoWriteOff(a.id))}>
              Undo write-off
            </button>
          ) : (
            <button className="btn btn-sm" disabled={!canModify || !a.openMonth} onClick={() => setDialog('writeoff')}>
              Write Off
            </button>
          )}
          <button className="btn btn-sm" disabled={!!a.writtenOffMonth} onClick={() => setDialog('transfer')}>
            Transfer
          </button>
          <button className="btn btn-sm" onClick={exportSchedule}>
            Export
          </button>
          {a.editable && (
            <button
              className="btn btn-sm text-rose-700"
              onClick={() => window.confirm(`Delete ${a.code}? It has not been booked, so nothing reaches the books.`) && act(() => api.deleteAsset(a.id), onBack)}
            >
              Delete Amortization
            </button>
          )}
        </div>
      </div>
      <ErrorBar error={error} onDismiss={() => setError(null)} />

      <Section title="Primary Information">
        <Field label="ID">{a.code}</Field>
        <Field label="Type">{a.typeName}</Field>
        <Field label="Department">{a.department}</Field>
        <Field label="Name">{a.name}</Field>
        <Field label="Status">
          <StatusBadge status={a.status} />
        </Field>
        <Field label="Source">{a.origin === 'manual' ? (a.opening ? 'Manual (opening balance)' : 'Manual') : (a.runName ?? 'Commission run')}</Field>
        <Field label="Payee">{a.payee}</Field>
        <Field label="Reference">{a.dealKey}</Field>
        <Field label="Description">{a.description}</Field>
      </Section>
      <Section title="Schedule">
        <Field label="Capitalized">{monthLabel(a.capitalizedMonth)}</Field>
        <Field label="End date">{monthLabel(a.endMonth)}</Field>
        <Field label="Remaining balance">{money(a.remaining)}</Field>
        <Field label="Term">{a.months} months</Field>
        <Field label="Amount">{money(a.amount)}</Field>
        <Field label="Remaining periods">{a.remainingPeriods}</Field>
        <Field label="Start date">{monthLabel(a.startMonth)}</Field>
        <Field label="Method">{a.methodName}</Field>
        <Field label={a.asOf ? `As of ${monthLabel(a.asOf)}` : 'Booked'}>
          {booked ? (
            <span className="text-xs text-slate-500">
              Booked {monthLabel(a.bookedMonth!)} · amortized {money(a.amortizedToDate)} · current {money(a.current)} · non-current {money(a.noncurrent)}
            </span>
          ) : (
            <span className="text-xs text-amber-700">Pending: books with the {monthLabel(a.openMonth && a.capitalizedMonth < a.openMonth ? a.openMonth : a.capitalizedMonth)} close</span>
          )}
        </Field>
      </Section>

      <div className="mx-6 mt-2 mb-6 rounded-md border border-slate-200">
        <div className="flex gap-4 border-b border-slate-200 bg-slate-100 px-3 text-xs">
          {TABS.map((t) => (
            <button key={t.key} className={`py-2 ${tab === t.key ? 'border-b-2 border-indigo-500 font-semibold text-slate-800' : 'text-slate-500 hover:text-slate-700'}`} onClick={() => setTab(t.key)}>
              {t.label}
              {t.key === 'modifications' && modifications.length ? ` (${modifications.length})` : ''}
            </button>
          ))}
        </div>
        <div className="p-3">
          {tab === 'schedule' && (
            <table className="w-full text-xs">
              <thead className="text-left text-slate-400">
                <tr className="border-b border-slate-200">
                  <th className="py-1.5 pr-3 font-normal">Transaction type</th>
                  <th className="py-1.5 pr-3 text-right font-normal">Period</th>
                  <th className="py-1.5 pr-3 font-normal">Period start</th>
                  <th className="py-1.5 pr-3 font-normal">Period end</th>
                  <th className="py-1.5 pr-3 text-right font-normal">Amount</th>
                  <th className="py-1.5 pr-3 text-right font-normal">Remaining balance</th>
                  <th className="py-1.5 font-normal">Journal entry</th>
                </tr>
              </thead>
              <tbody>
                {a.schedule.map((s) => (
                  <tr key={`${s.type}-${s.period}`} className={`border-b border-slate-100 ${s.state === 'next_close' ? 'bg-indigo-50/50' : ''}`}>
                    <td className="py-1 pr-3">{s.type}</td>
                    <td className="py-1 pr-3 text-right">{s.period}</td>
                    <td className="py-1 pr-3">{date(s.start)}</td>
                    <td className="py-1 pr-3">{date(s.end)}</td>
                    <td className="py-1 pr-3 text-right">{money(s.amount)}</td>
                    <td className="py-1 pr-3 text-right">{money(s.remaining)}</td>
                    <td className="py-1">
                      {s.journal ? <span className="font-mono text-[11px] text-indigo-700">{s.journal}</span> : <span className="text-slate-400">{s.type === 'Opening balance' ? 'Already on the books' : STATE_LABEL[s.state]}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {tab === 'modifications' &&
            (modifications.length ? (
              <History items={modifications} />
            ) : (
              <div className="py-4 text-center text-xs text-slate-400">No modifications. Use Modify, Transfer or Write Off to change this amortization from the open month on.</div>
            ))}
          {tab === 'accounting' && (
            <table className="w-full text-xs">
              <thead className="text-left text-slate-400">
                <tr className="border-b border-slate-200">
                  <th className="py-1.5 pr-3 font-normal">Role</th>
                  <th className="py-1.5 pr-3 font-normal">Account</th>
                  <th className="py-1.5 font-normal">How it is used</th>
                </tr>
              </thead>
              <tbody>
                {a.accountRoles.map((x) => (
                  <tr key={x.role} className="border-b border-slate-100">
                    <td className="py-1 pr-3">{x.role}</td>
                    <td className="py-1 pr-3">
                      <span className="mr-1.5 font-mono text-[11px] text-slate-400">{x.account.number}</span>
                      {x.account.name}
                    </td>
                    <td className="py-1 text-slate-500">{x.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {tab === 'notes' && <History items={[...a.history].reverse()} />}
        </div>
      </div>

      {dialog === 'edit' && <AmortizationForm asset={a} openMonth={a.openMonth} onClose={() => setDialog(null)} onSaved={() => (setDialog(null), load())} />}
      {dialog === 'modify' && <ModifyDialog a={a} onClose={() => setDialog(null)} onSave={(body) => act(() => api.updateAsset(a.id, body))} />}
      {dialog === 'transfer' && <TransferDialog a={a} onClose={() => setDialog(null)} onSave={(body) => act(() => api.transferAsset(a.id, body))} />}
      {dialog === 'writeoff' && <WriteOffDialog a={a} onClose={() => setDialog(null)} onSave={(reason) => act(() => api.writeOffAsset(a.id, reason))} />}
    </div>
  );
}


function History({ items }: { items: AssetDetail['history'] }) {
  return (
    <table className="w-full text-xs">
      <thead className="text-left text-slate-400">
        <tr className="border-b border-slate-200">
          <th className="py-1.5 pr-3 font-normal">Date</th>
          <th className="py-1.5 pr-3 font-normal">By</th>
          <th className="py-1.5 pr-3 font-normal">Action</th>
          <th className="py-1.5 pr-3 font-normal">Effective</th>
          <th className="py-1.5 font-normal">Changes</th>
        </tr>
      </thead>
      <tbody>
        {items.map((h, i) => (
          <tr key={i} className="border-b border-slate-100 align-top">
            <td className="py-1 pr-3 whitespace-nowrap">{new Date(h.at).toLocaleString()}</td>
            <td className="py-1 pr-3">{h.by}</td>
            <td className="py-1 pr-3">{ACTION_LABEL[h.action] ?? h.action}</td>
            <td className="py-1 pr-3 whitespace-nowrap">{h.effectiveMonth ? monthLabel(h.effectiveMonth) : ''}</td>
            <td className="py-1">
              {h.changes.map((c, j) => (
                <div key={j}>
                  {c.field}: <span className="text-slate-400">{fmt(c.from)}</span> → {fmt(c.to)}
                </div>
              ))}
              {h.note && <div className="text-slate-500">{h.note}</div>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ModifyDialog({ a, onClose, onSave }: { a: AssetDetail; onClose: () => void; onSave: (body: { name: string; description: string | null; dealKey: string | null; startMonth?: string; endMonth: string; note: string | null }) => void }) {
  const [name, setName] = useState(a.name);
  const [description, setDescription] = useState(a.description ?? '');
  const [dealKey, setDealKey] = useState(a.dealKey ?? '');
  const [startMonth, setStartMonth] = useState(a.startMonth);
  const [endMonth, setEndMonth] = useState(a.endMonth);
  const [note, setNote] = useState('');
  const started = !!a.openMonth && a.startMonth < a.openMonth;
  const rescheduled = endMonth !== a.endMonth || startMonth !== a.startMonth;
  return (
    <Modal title={`Modify ${a.code}`} onClose={onClose}>
      <div className="grid grid-cols-2 gap-2 text-xs text-slate-600">
        <label className="col-span-2">
          Name
          <input className="input mt-1 block w-full" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Reference
          <input className="input mt-1 block w-full" value={dealKey} onChange={(e) => setDealKey(e.target.value)} />
        </label>
        <label>
          Description
          <input className="input mt-1 block w-full" value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label>
          Start
          <input type="month" className="input mt-1 block w-full" disabled={started} title={started ? 'Amortization has been booked; the start is fixed' : undefined} value={startMonth} onChange={(e) => e.target.value && setStartMonth(e.target.value)} />
        </label>
        <label>
          End
          <input type="month" className="input mt-1 block w-full" value={endMonth} onChange={(e) => e.target.value && setEndMonth(e.target.value)} />
        </label>
        {rescheduled && (
          <div className="col-span-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800">
            A change in estimate, applied from {a.openMonth ? monthLabel(a.openMonth) : 'the open month'} on: closed months stay as booked, and the remaining {money(a.remaining)} is spread evenly through {monthLabel(endMonth)}.
          </div>
        )}
        <label className="col-span-2">
          Reason <span className="text-slate-400">(kept in Modifications)</span>
          <input className="input mt-1 block w-full" value={note} placeholder="e.g. Customer renewed early; customer life re-estimated" onChange={(e) => setNote(e.target.value)} />
        </label>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn btn-primary"
          disabled={!name.trim()}
          onClick={() => onSave({ name: name.trim(), description: description || null, dealKey: dealKey || null, ...(started ? {} : { startMonth }), endMonth, note: note || null })}
        >
          Save modification
        </button>
      </div>
    </Modal>
  );
}

function TransferDialog({ a, onClose, onSave }: { a: AssetDetail; onClose: () => void; onSave: (body: { department: string; typeId: string | null; note: string | null }) => void }) {
  const [department, setDepartment] = useState(a.department);
  const [typeId, setTypeId] = useState<string | null>(a.typeId);
  const [note, setNote] = useState('');
  const [types, setTypes] = useState<AmortizationTypeRow[]>([]);
  const [departments, setDepartments] = useState<string[]>([]);
  useEffect(() => {
    api.listAmortizationTypes().then((p) => setTypes(p.types.filter((t) => t.treatment === 'capitalize'))).catch(() => {});
    api.listEmployeeTypes().then((t) => setDepartments(t.map((x) => x.name).sort())).catch(() => {});
  }, []);
  return (
    <Modal title={`Transfer ${a.code}`} onClose={onClose}>
      <div className="space-y-2 text-xs text-slate-600">
        <p className="text-slate-500">Moves the remaining amortization to another department or type. Months already closed stay where they were booked.</p>
        <label className="block">
          Department
          <input className="input mt-1 block w-full" list="amrt-transfer-depts" value={department} onChange={(e) => setDepartment(e.target.value)} />
          <datalist id="amrt-transfer-depts">
            {departments.map((d) => (
              <option key={d} value={d} />
            ))}
          </datalist>
        </label>
        <label className="block">
          Amortization type
          <select className="select mt-1 block w-full" value={typeId ?? ''} onChange={(e) => setTypeId(e.target.value || null)}>
            <option value="">Keep {a.typeName}</option>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          Reason
          <input className="input mt-1 block w-full" value={note} placeholder="e.g. Rep moved to the Mid-Market team" onChange={(e) => setNote(e.target.value)} />
        </label>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={!department.trim()} onClick={() => onSave({ department: department.trim(), typeId, note: note || null })}>
          Transfer
        </button>
      </div>
    </Modal>
  );
}

function WriteOffDialog({ a, onClose, onSave }: { a: AssetDetail; onClose: () => void; onSave: (reason: string) => void }) {
  const [reason, setReason] = useState('Customer churned');
  return (
    <Modal title={`Write off ${a.code}`} onClose={onClose}>
      <p className="text-xs text-slate-500">
        Writes off the remaining {money(a.remaining)} in {a.openMonth ? monthLabel(a.openMonth) : 'the open month'} (Dr write-off expense, Cr deferred commissions). You can undo it until that month closes.
      </p>
      <label className="mt-2 block text-xs text-slate-600">
        Reason
        <input className="input mt-1 block w-full" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={!reason.trim()} onClick={() => onSave(reason.trim())}>
          Write off
        </button>
      </div>
    </Modal>
  );
}
