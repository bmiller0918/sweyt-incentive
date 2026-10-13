// New (or not-yet-booked) amortization entered by hand: a prepaid commission
// paid outside a run, a guaranteed draw, or an opening balance migrated from
// a spreadsheet. It books with the close of its capitalized month.
import { useEffect, useMemo, useState } from 'react';
import { api, type AccountingSettingsRow, type AmortizationMethodRow, type AmortizationTypeRow, type AssetDetail, type ManualAmortizationInput } from '../../api';
import { Bars, Modal, money, monthLabel } from './ui';

const thisMonth = () => new Date().toISOString().slice(0, 7);

export function AmortizationForm({ asset, openMonth, onClose, onSaved }: { asset?: AssetDetail | null; openMonth: string | null; onClose: () => void; onSaved: (id: string) => void }) {
  const [types, setTypes] = useState<AmortizationTypeRow[]>([]);
  const [methods, setMethods] = useState<AmortizationMethodRow[]>([]);
  const [departments, setDepartments] = useState<string[]>([]);
  const [payees, setPayees] = useState<string[]>([]);
  const [settings, setSettings] = useState<AccountingSettingsRow | null>(null);
  const start = openMonth ?? thisMonth();
  const [f, setF] = useState<ManualAmortizationInput>(() =>
    asset
      ? {
          name: asset.name,
          payee: asset.payee,
          department: asset.department,
          typeId: asset.typeId,
          methodId: asset.methodId,
          amount: asset.amount,
          capitalizedMonth: asset.capitalizedMonth,
          startMonth: asset.startMonth,
          months: asset.months,
          description: asset.description,
          dealKey: asset.dealKey,
          opening: !!asset.opening,
          offsetAccount: asset.offsetAccount ?? null,
        }
      : { name: '', payee: '', department: '', typeId: null, methodId: null, amount: 0, capitalizedMonth: start, startMonth: start, months: 12, description: null, dealKey: null, opening: false, offsetAccount: null },
  );
  const [amountText, setAmountText] = useState(asset ? String(asset.amount) : '');
  const [preview, setPreview] = useState<{ endMonth: string; months: number; byMonth: Record<string, number> } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.listAmortizationTypes().then((p) => setTypes(p.types.filter((t) => t.treatment === 'capitalize'))).catch(() => {});
    api.listMethods().then((m) => setMethods(m.filter((x) => x.def.kind !== 'immediate'))).catch(() => {});
    api.listEmployeeTypes().then((t) => setDepartments(t.map((x) => x.name).sort())).catch(() => {});
    api.listEmployees().then((e) => setPayees(e.map((x) => x.name).sort())).catch(() => {});
    api.getAccountingSettings().then(setSettings).catch(() => {});
  }, []);

  const set = <K extends keyof ManualAmortizationInput>(k: K, v: ManualAmortizationInput[K]) => setF((cur) => ({ ...cur, [k]: v }));
  const amount = Number(amountText.replace(/[$,\s]/g, ''));
  const body = useMemo(() => ({ ...f, amount: Number.isFinite(amount) ? amount : 0 }), [f, amount]);

  // Live schedule preview.
  useEffect(() => {
    if (!body.amount) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    let stale = false;
    const t = setTimeout(() => {
      api
        .previewAsset({ ...body, name: body.name || 'Preview', payee: body.payee || 'Preview' })
        .then((p) => {
          if (stale) return;
          setPreview(p);
          setPreviewError(null);
        })
        .catch((e) => {
          if (stale) return;
          setPreview(null);
          setPreviewError(e.message);
        });
    }, 250);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [body]);

  const pickType = (id: string) => {
    const t = types.find((x) => x.id === id) ?? null;
    setF((cur) => ({ ...cur, typeId: t?.id ?? null, methodId: cur.methodId ?? (t?.methodId && methods.some((m) => m.id === t.methodId) ? t.methodId : null) }));
  };
  const method = methods.find((m) => m.id === f.methodId) ?? null;
  const fixedTerm = method?.def.kind === 'straight_line' && method.def.periodBasis === 'fixed_months';
  const curveTerm = method && method.def.kind !== 'straight_line';
  const accrued = settings?.accounts.accruedCommissions;
  const lateBooking = openMonth && f.capitalizedMonth < openMonth;
  const valid = f.name.trim() && f.payee.trim() && body.amount && f.months >= 1 && !previewError;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      if (asset) {
        await api.updateAsset(asset.id, body);
        onSaved(asset.id);
      } else {
        const r = await api.createAsset(body);
        onSaved(r.id);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const months = preview ? Object.keys(preview.byMonth).sort() : [];
  return (
    <Modal title={asset ? `Edit ${asset.code}` : 'New amortization'} onClose={onClose} width="w-[46rem]">
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs text-slate-600">
        <div className="col-span-2 text-[11px] font-semibold tracking-wide text-slate-400 uppercase">Primary information</div>
        <label>
          Name
          <input className="input mt-1 block w-full" autoFocus value={f.name} placeholder="e.g. Guaranteed draw, J. Smith, Q1" onChange={(e) => set('name', e.target.value)} />
        </label>
        <label>
          Payee
          <input className="input mt-1 block w-full" list="amrt-payees" value={f.payee} placeholder="Employee or vendor" onChange={(e) => set('payee', e.target.value)} />
          <datalist id="amrt-payees">
            {payees.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </label>
        <label>
          Amortization type
          <select className="select mt-1 block w-full" value={f.typeId ?? ''} onChange={(e) => pickType(e.target.value)}>
            <option value="">None</option>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Department
          <input className="input mt-1 block w-full" list="amrt-depts" value={f.department} placeholder="Charged with the amortization" onChange={(e) => set('department', e.target.value)} />
          <datalist id="amrt-depts">
            {departments.map((d) => (
              <option key={d} value={d} />
            ))}
          </datalist>
        </label>
        <label>
          Reference <span className="text-slate-400">(deal, invoice; optional)</span>
          <input className="input mt-1 block w-full" value={f.dealKey ?? ''} onChange={(e) => set('dealKey', e.target.value || null)} />
        </label>
        <label>
          Description <span className="text-slate-400">(optional)</span>
          <input className="input mt-1 block w-full" value={f.description ?? ''} onChange={(e) => set('description', e.target.value || null)} />
        </label>

        <div className="col-span-2 mt-2 text-[11px] font-semibold tracking-wide text-slate-400 uppercase">Schedule</div>
        <label>
          Amount
          <input className="input mt-1 block w-full" inputMode="decimal" value={amountText} placeholder="0.00" onChange={(e) => setAmountText(e.target.value)} />
        </label>
        <label>
          Method
          <select className="select mt-1 block w-full" value={f.methodId ?? ''} onChange={(e) => set('methodId', e.target.value || null)}>
            <option value="">Straight-line</option>
            {methods.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Capitalized month
          <input
            type="month"
            className="input mt-1 block w-full"
            value={f.capitalizedMonth}
            onChange={(e) => e.target.value && setF((cur) => ({ ...cur, capitalizedMonth: e.target.value, startMonth: cur.startMonth < e.target.value ? e.target.value : cur.startMonth }))}
          />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label>
            Start
            <input type="month" className="input mt-1 block w-full" value={f.startMonth} onChange={(e) => e.target.value && set('startMonth', e.target.value)} />
          </label>
          <label>
            Term (months)
            <input
              type="number"
              min={1}
              className="input mt-1 block w-full"
              value={f.months}
              disabled={!!fixedTerm || !!curveTerm}
              title={fixedTerm || curveTerm ? 'This method sets its own length' : undefined}
              onChange={(e) => set('months', Math.max(1, Math.round(Number(e.target.value) || 1)))}
            />
          </label>
        </div>

        <div className="col-span-2 rounded-md border border-slate-200 p-2">
          {previewError ? (
            <div className="text-rose-700">{previewError}</div>
          ) : preview ? (
            <>
              <div className="mb-1 flex flex-wrap gap-x-4 text-slate-500">
                <span>
                  {monthLabel(f.startMonth)} – {monthLabel(preview.endMonth)}
                </span>
                <span>{preview.months} months</span>
                <span>First month {money(preview.byMonth[months[0]])}</span>
                <span>Ends {monthLabel(preview.endMonth)}</span>
              </div>
              <Bars height={40} data={months.map((m) => ({ label: monthLabel(m), value: preview.byMonth[m] }))} />
            </>
          ) : (
            <div className="text-slate-400">Enter an amount to see the schedule.</div>
          )}
        </div>

        <div className="col-span-2 mt-2 text-[11px] font-semibold tracking-wide text-slate-400 uppercase">Accounting</div>
        <label className="col-span-2 flex items-start gap-2">
          <input type="checkbox" className="mt-0.5" checked={f.opening} onChange={(e) => set('opening', e.target.checked)} />
          <span>
            Opening balance already on the books
            <span className="block text-[11px] text-slate-400">
              For balances migrated from a spreadsheet or another system: enter what is left and the months left. No capitalization entry is booked, and the roll forward shows it as initial balance.
            </span>
          </span>
        </label>
        {!f.opening && (
          <div className="col-span-2 grid grid-cols-[8rem_1fr] gap-2">
            <label>
              Offset account
              <input
                className="input mt-1 block w-full font-mono"
                value={f.offsetAccount?.number ?? accrued?.number ?? ''}
                onChange={(e) => set('offsetAccount', { number: e.target.value, name: f.offsetAccount?.name ?? accrued?.name ?? '' })}
              />
            </label>
            <label>
              &nbsp;
              <input
                className="input mt-1 block w-full"
                value={f.offsetAccount?.name ?? accrued?.name ?? ''}
                placeholder="Account credited when capitalized"
                onChange={(e) => set('offsetAccount', { number: f.offsetAccount?.number ?? accrued?.number ?? '', name: e.target.value })}
              />
            </label>
            <div className="col-span-2 text-[11px] text-slate-400">
              Credited when the cost is capitalized (Dr deferred commissions, Cr this account). Defaults to accrued commissions; use cash or accounts payable if it was paid outside payroll.
              {f.offsetAccount && (
                <button className="ml-1 underline" onClick={() => set('offsetAccount', null)}>
                  Use the default
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {lateBooking && (
        <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {monthLabel(f.capitalizedMonth)} is closed, so this books with the {monthLabel(openMonth!)} close, including any amortization it has missed.
        </div>
      )}
      {error && <div className="mt-3 text-xs text-rose-700">{error}</div>}
      <div className="mt-4 flex items-center justify-end gap-2">
        <span className="mr-auto text-[11px] text-slate-400">
          {openMonth ? `Books with the ${monthLabel(f.capitalizedMonth < openMonth ? openMonth : f.capitalizedMonth)} close.` : `Books with the ${monthLabel(f.capitalizedMonth)} close.`}
        </span>
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={!valid || saving} onClick={save}>
          {saving ? 'Saving…' : asset ? 'Save' : 'Create amortization'}
        </button>
      </div>
    </Modal>
  );
}
