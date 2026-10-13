import { METRIC_AGGS, PROGRAM_KINDS, PROGRAM_KIND_LABELS, emptyDefinition, familyOf, type Condition, type MetricAgg, type ProgramDefinition, type ProgramKind } from '@commissions/shared';
import { useCallback, useEffect, useState } from 'react';
import { api, type EmployeeType, type ImportDetail, type ImportSummary, type IncentiveProgram, type IncentiveProgramInput, type ProgramPreview, type RuleField } from '../api';
import { PeriodPicker } from './PeriodPicker';
import { ConditionTable, defaultOperator, defaultValues } from './PayoutRulesView';

/**
 * Spiffs, accelerators and bonuses: incentives that pay on a metric for a
 * window, beside the annual plan. Grouped the way they are set up: counts
 * (spiffs), a time period with a rate (accelerators) and metrics (bonuses).
 * Every enabled program pays in commission runs whose window overlaps it.
 */

const emptyProgram = (kind: ProgramKind): IncentiveProgramInput => ({
  name: '',
  description: '',
  kind,
  enabled: true,
  importId: null,
  employeeTypeIds: [],
  effectiveFrom: null,
  effectiveTo: null,
  definition: kind === 'accelerator' ? { ...emptyDefinition(), measure: { agg: 'sum', field: null } } : emptyDefinition(),
});

/** "8%" -> 0.08, "$50,000" -> 50000. */
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
const pct = (n: number) => `${Math.round(n * 10000) / 100}%`;
const money = (n: number) => n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const num = (n: number | null) => (n === null ? '—' : n.toLocaleString(undefined, { maximumFractionDigits: 2 }));
const uid = () => `f${Math.random().toString(36).slice(2, 8)}`;
const isNum = (t: string) => ['currency', 'decimal', 'integer'].includes(t);

const AGG_LABELS: Record<MetricAgg, string> = { count: 'Count of rows', sum: 'Sum of', average: 'Average of', max: 'Highest' };

function summary(p: IncentiveProgram): string {
  const d = p.definition;
  if (p.kind === 'spiff') return d.spiff.rateKind === 'percent' ? `${pct(d.spiff.rate)} of the total` : `${money(d.spiff.rate)} per unit`;
  if (p.kind === 'accelerator') return `+${pct(d.accelerator.uplift)} above ${money(d.accelerator.threshold)}`;
  return `${d.bonus.tiers.length} tier${d.bonus.tiers.length === 1 ? '' : 's'}, ${d.bonus.period === 'window' ? 'whole window' : `each ${d.bonus.period}`}`;
}

export function ProgramsView() {
  const [programs, setPrograms] = useState<IncentiveProgram[]>([]);
  const [imports, setImports] = useState<ImportSummary[]>([]);
  const [types, setTypes] = useState<EmployeeType[]>([]);
  const [selectedId, setSelectedId] = useState<string | 'new' | null>(null);
  const [draft, setDraft] = useState<IncentiveProgramInput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [editorKey, setEditorKey] = useState(0);

  const refresh = useCallback(async () => {
    const p = await api.listPrograms();
    setPrograms(p);
    return p;
  }, []);

  useEffect(() => {
    Promise.all([refresh(), api.listImports(), api.listEmployeeTypes()])
      .then(([p, imps, ts]) => {
        setImports(imps);
        setTypes(ts);
        if (p.length) select(p[0]);
        else select('new', 'spiff');
      })
      .catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const select = (p: IncentiveProgram | 'new', kind: ProgramKind = 'spiff') => {
    setEditorKey((k) => k + 1);
    if (p === 'new') {
      setSelectedId('new');
      setDraft(emptyProgram(kind));
      return;
    }
    setSelectedId(p.id);
    const { id: _id, updatedAt: _u, ...rest } = p;
    setDraft({ ...rest, description: rest.description ?? '' });
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const body = { ...draft, description: draft.description || null };
      const saved = selectedId === 'new' || !selectedId ? await api.createProgram(body) : await api.updateProgram(selectedId, body);
      await refresh();
      select(saved);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!selectedId || selectedId === 'new') return;
    const p = programs.find((x) => x.id === selectedId);
    if (!p || !window.confirm(`Delete "${p.name}"? Runs already calculated keep their lines.`)) return;
    await api.deleteProgram(selectedId);
    const list = await refresh();
    if (list.length) select(list[0]);
    else select('new', 'spiff');
  };

  return (
    <div className="flex h-full">
      <aside className="flex w-72 shrink-0 flex-col border-r border-slate-200 bg-panel">
        <div className="border-b border-slate-200 px-3 py-2">
          <div className="text-sm font-semibold">Spiffs, accelerators and bonuses</div>
          <div className="text-xs text-slate-400">Paid on top of the annual plan, in every commission run their window overlaps.</div>
        </div>
        <div className="flex-1 overflow-auto p-2">
          {PROGRAM_KINDS.map((kind) => {
            const list = programs.filter((p) => p.kind === kind);
            return (
              <div key={kind} className="mb-3">
                <div className="flex items-center px-2 py-1">
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{PROGRAM_KIND_LABELS[kind].plural}</div>
                    <div className="text-[11px] text-slate-400">{PROGRAM_KIND_LABELS[kind].short}</div>
                  </div>
                  <div className="flex-1" />
                  <button className="btn btn-sm" onClick={() => select('new', kind)}>
                    + New
                  </button>
                </div>
                {list.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => select(p)}
                    className={`block w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-slate-100 ${selectedId === p.id ? 'bg-indigo-50 text-indigo-700' : 'text-slate-700'} ${p.enabled ? '' : 'opacity-60'}`}
                  >
                    <div className="truncate font-medium">
                      {p.name}
                      {!p.enabled && <span className="ml-1 text-[11px] font-normal text-slate-400">(off)</span>}
                    </div>
                    <div className="truncate text-xs text-slate-400">{summary(p)}</div>
                  </button>
                ))}
                {!list.length && <div className="px-2 text-xs text-slate-400">None yet.</div>}
              </div>
            );
          })}
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
        {draft && (
          <ProgramEditor
            key={editorKey}
            draft={draft}
            setDraft={setDraft}
            isNew={selectedId === 'new'}
            imports={imports}
            types={types}
            saving={saving}
            onSave={save}
            onDelete={remove}
            onError={setError}
          />
        )}
      </div>
    </div>
  );
}

function ProgramEditor({
  draft,
  setDraft,
  isNew,
  imports,
  types,
  saving,
  onSave,
  onDelete,
  onError,
}: {
  draft: IncentiveProgramInput;
  setDraft: (d: IncentiveProgramInput) => void;
  isNew: boolean;
  imports: ImportSummary[];
  types: EmployeeType[];
  saving: boolean;
  onSave: () => void;
  onDelete: () => void;
  onError: (m: string) => void;
}) {
  const [detail, setDetail] = useState<ImportDetail | null>(null);
  const [preview, setPreview] = useState<ProgramPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const d = draft.definition;
  const setDef = (patch: Partial<ProgramDefinition>) => setDraft({ ...draft, definition: { ...d, ...patch } });
  const kind = PROGRAM_KIND_LABELS[draft.kind];

  useEffect(() => {
    if (!draft.importId) return setDetail(null);
    api
      .getImport(draft.importId)
      .then(setDetail)
      .catch((e) => onError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.importId]);
  useEffect(() => setPreview(null), [draft]);

  const cols = detail?.columns ?? [];
  const fields: RuleField[] = cols.map((c) => ({ name: c.name, type: c.type, imports: [] }));
  const numCols = cols.filter((c) => isNum(c.type)).map((c) => c.name);
  const dateCols = cols.filter((c) => c.type === 'date' || c.type === 'datetime').map((c) => c.name);

  /** Guess the person and date columns when an import is picked. */
  const pickImport = (id: string) => {
    const imp = imports.find((i) => i.id === id);
    setDraft({ ...draft, importId: id || null });
    if (!imp) return;
    api.getImport(id).then((det) => {
      const names = det.columns.map((c) => c.name);
      const rep = names.find((n) => /\b(rep|owner|salesperson|employee|ae|sdr|bdr|user|name)\b/i.test(n)) ?? '';
      const date = det.columns.find((c) => (c.type === 'date' || c.type === 'datetime') && /date|close|booked|created|activity/i.test(c.name))?.name ?? det.columns.find((c) => c.type === 'date')?.name ?? null;
      const amount = draft.kind === 'accelerator' ? (det.columns.find((c) => isNum(c.type) && /amount|acv|arr|booking|value/i.test(c.name))?.name ?? null) : d.measure.field;
      setDraft({ ...draft, importId: id, definition: { ...d, repField: rep, dateField: date, filters: [], measure: { ...d.measure, field: amount } } });
    });
  };

  const addFilter = () => {
    const first = fields[0];
    if (!first) return;
    const op = defaultOperator(familyOf(first.type));
    setDef({ filters: [...d.filters, { type: 'condition', id: uid(), field: first.name, operator: op, values: defaultValues(op) }] });
  };

  const runPreview = async () => {
    setPreviewing(true);
    try {
      setPreview(await api.previewProgram({ ...draft, description: draft.description || null }));
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setPreviewing(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-6">
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <div>
            <h2 className="text-base font-semibold">{isNew ? `New ${kind.label.toLowerCase()}` : kind.label}</h2>
            <div className="text-xs text-slate-400">{kind.hint}</div>
          </div>
          <div className="flex-1" />
          <label className="flex items-center gap-1 text-xs text-slate-600">
            <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} /> Enabled
          </label>
          {!isNew && (
            <button className="btn text-rose-600" onClick={onDelete}>
              Delete
            </button>
          )}
          <button className="btn btn-primary" disabled={saving || !draft.name.trim()} onClick={onSave}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3 text-xs">
          <label className="text-slate-600">
            Name
            <input className="input mt-1 block w-full" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder={draft.kind === 'spiff' ? 'e.g. March demo spiff' : draft.kind === 'accelerator' ? 'e.g. Q4 push' : 'e.g. Quarterly attainment bonus'} />
          </label>
          <label className="text-slate-600">
            Type
            <select className="select mt-1 block w-full" value={draft.kind} disabled={!isNew} onChange={(e) => setDraft(emptyProgram(e.target.value as ProgramKind))}>
              {PROGRAM_KINDS.map((k) => (
                <option key={k} value={k}>
                  {PROGRAM_KIND_LABELS[k].label} ({PROGRAM_KIND_LABELS[k].short.toLowerCase()})
                </option>
              ))}
            </select>
          </label>
          <label className="col-span-2 text-slate-600">
            Description
            <input className="input mt-1 block w-full" value={draft.description ?? ''} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          </label>
          <div className="text-slate-600">
            Time period
            <div className="mt-1">
              <PeriodPicker from={draft.effectiveFrom} to={draft.effectiveTo} onChange={(effectiveFrom, effectiveTo) => setDraft({ ...draft, effectiveFrom, effectiveTo })} />
            </div>
          </div>
          <div className="text-slate-600">
            Who it's for <span className="text-slate-400">(none checked = everyone)</span>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
              {types.map((t) => (
                <label key={t.id} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={draft.employeeTypeIds.includes(t.id)}
                    onChange={(e) => setDraft({ ...draft, employeeTypeIds: e.target.checked ? [...draft.employeeTypeIds, t.id] : draft.employeeTypeIds.filter((x) => x !== t.id) })}
                  />
                  {t.name}
                </label>
              ))}
              {!types.length && <span className="text-slate-400">No employee types yet.</span>}
            </div>
          </div>
        </div>
      </section>

      <section className="space-y-3 rounded-md border border-slate-200 p-4">
        <div>
          <h3 className="text-sm font-semibold text-slate-700">Metric</h3>
          <p className="text-xs text-slate-400">The rows that count, from any import: deals, an activity export, an uploaded scorecard.</p>
        </div>
        <div className="grid grid-cols-3 gap-3 text-xs">
          <label className="text-slate-600">
            Import
            <select className="select mt-1 block w-full" value={draft.importId ?? ''} onChange={(e) => pickImport(e.target.value)}>
              <option value="">Pick an import…</option>
              {imports.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
          </label>
          <ColumnSelect label="Person credited" value={d.repField} options={cols.map((c) => c.name)} onChange={(v) => setDef({ repField: v ?? '' })} />
          <ColumnSelect label="Date" value={d.dateField} options={dateCols} onChange={(v) => setDef({ dateField: v })} blank="No date (every row counts)" />
          {draft.kind === 'accelerator' ? (
            <>
              <ColumnSelect label="Dollars" value={d.measure.field} options={numCols} onChange={(v) => setDef({ measure: { agg: 'sum', field: v } })} />
              <ColumnSelect label="Deal ID (optional)" value={d.dealKeyField} options={cols.map((c) => c.name)} onChange={(v) => setDef({ dealKeyField: v })} blank="None" />
            </>
          ) : (
            <>
              <label className="text-slate-600">
                Measure
                <select className="select mt-1 block w-full" value={d.measure.agg} onChange={(e) => setDef({ measure: { ...d.measure, agg: e.target.value as MetricAgg } })}>
                  {METRIC_AGGS.map((a) => (
                    <option key={a} value={a}>
                      {AGG_LABELS[a]}
                    </option>
                  ))}
                </select>
              </label>
              {d.measure.agg !== 'count' && <ColumnSelect label="Column" value={d.measure.field} options={numCols} onChange={(v) => setDef({ measure: { ...d.measure, field: v } })} />}
            </>
          )}
        </div>
        <div>
          <div className="flex items-center text-xs">
            <span className="font-semibold text-slate-600">Only rows where</span>
            <div className="flex-1" />
            <button className="btn btn-sm" disabled={!fields.length} onClick={addFilter}>
              + Filter
            </button>
          </div>
          <ConditionTable rows={d.filters as Condition[]} fields={fields} onChange={(filters) => setDef({ filters })} empty={detail ? 'Every row counts. Add a filter, e.g. Activity is Demo.' : 'Pick an import first.'} />
        </div>
      </section>

      <section className="space-y-3 rounded-md border border-slate-200 p-4 text-xs">
        <h3 className="text-sm font-semibold text-slate-700">Payout</h3>
        {draft.kind === 'spiff' && <SpiffPayout d={d} setDef={setDef} />}
        {draft.kind === 'accelerator' && <AcceleratorPayout d={d} setDef={setDef} />}
        {draft.kind === 'bonus' && <BonusPayout d={d} setDef={setDef} />}
      </section>

      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-slate-700">Preview</h3>
          <span className="text-xs text-slate-400">What it would pay over its whole time period, from the import as it is now.</span>
          <div className="flex-1" />
          <button className="btn btn-sm" disabled={previewing || !draft.importId} onClick={runPreview}>
            {previewing ? 'Calculating…' : 'Calculate'}
          </button>
        </div>
        {preview && <PreviewTable preview={preview} kind={draft.kind} />}
      </section>
    </div>
  );
}

function ColumnSelect({ label, value, options, onChange, blank }: { label: string; value: string | null; options: string[]; onChange: (v: string | null) => void; blank?: string }) {
  return (
    <label className="text-slate-600">
      {label}
      <select className="select mt-1 block w-full" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">{blank ?? 'Pick a column…'}</option>
        {value && !options.includes(value) && <option value={value}>{value} (not in this import)</option>}
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

/** A number field that keeps its text while typing ("8%", "$1,000"). */
function NumField({ value, show, onChange, placeholder, className }: { value: number | null; show: (n: number) => string; onChange: (n: number | null) => void; placeholder?: string; className?: string }) {
  const [text, setText] = useState(value === null ? '' : show(value));
  return (
    <input
      className={`input ${className ?? 'w-28'}`}
      placeholder={placeholder}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onChange(parseNum(e.target.value));
      }}
    />
  );
}

function SpiffPayout({ d, setDef }: { d: ProgramDefinition; setDef: (p: Partial<ProgramDefinition>) => void }) {
  const s = d.spiff;
  const percent = s.rateKind === 'percent';
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-slate-500">Pay</span>
      <NumField key={s.rateKind} value={s.rate} show={percent ? pct : (n) => `$${n}`} placeholder={percent ? '2%' : '$10'} onChange={(n) => setDef({ spiff: { ...s, rate: percent && n !== null && n >= 1 ? n / 100 : (n ?? 0) } })} />
      <select className="select" value={s.rateKind} onChange={(e) => setDef({ spiff: { ...s, rateKind: e.target.value as 'per_unit' | 'percent' } })}>
        <option value="per_unit">per unit of the metric (e.g. per demo)</option>
        <option value="percent">of the metric's dollar total</option>
      </select>
      <select className="select" value={s.period} onChange={(e) => setDef({ spiff: { ...s, period: e.target.value as 'window' | 'month' | 'quarter' } })}>
        <option value="window">counted over the whole time period</option>
        <option value="month">counted each month</option>
        <option value="quarter">counted each quarter</option>
      </select>
      <span className="ml-4 text-slate-500">Cap per person</span>
      <NumField value={s.cap} show={(n) => `$${n}`} placeholder="No cap" onChange={(n) => setDef({ spiff: { ...s, cap: n } })} />
      <div className="w-full text-slate-400">Pays in the commission run that holds the last day of each period. A time period with no end date is counted each month.</div>
    </div>
  );
}

function AcceleratorPayout({ d, setDef }: { d: ProgramDefinition; setDef: (p: Partial<ProgramDefinition>) => void }) {
  const a = d.accelerator;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-slate-500">Once someone's dollars in the time period pass</span>
        <NumField value={a.threshold} show={(n) => `$${n.toLocaleString()}`} placeholder="$500,000" onChange={(n) => setDef({ accelerator: { ...a, threshold: n ?? 0 } })} />
        <span className="text-slate-500">pay an extra</span>
        <NumField value={a.uplift} show={pct} placeholder="3%" className="w-20" onChange={(n) => setDef({ accelerator: { ...a, uplift: n !== null && n >= 1 ? n / 100 : (n ?? 0) } })} />
        <span className="text-slate-500">on the dollars above it.</span>
      </div>
      <div className="text-slate-400">This is on top of the plan's own rate. A deal that crosses the threshold earns the extra rate on the part above it only. Deals from earlier months in the time period count toward the threshold; each run pays its own deals.</div>
    </div>
  );
}

function BonusPayout({ d, setDef }: { d: ProgramDefinition; setDef: (p: Partial<ProgramDefinition>) => void }) {
  const b = d.bonus;
  const [rows, setRows] = useState(() => b.tiers.map((t) => ({ from: String(t.from), amount: `$${t.amount}` })));
  const commit = (next: { from: string; amount: string }[]) => {
    setRows(next);
    setDef({ bonus: { ...b, tiers: next.map((r) => ({ from: parseNum(r.from) ?? 0, amount: parseNum(r.amount) ?? 0 })) } });
  };
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-slate-500">Measure the metric</span>
        <select className="select" value={b.period} onChange={(e) => setDef({ bonus: { ...b, period: e.target.value as 'window' | 'month' | 'quarter' } })}>
          <option value="window">over the whole time period</option>
          <option value="month">each month</option>
          <option value="quarter">each quarter</option>
        </select>
        <span className="text-slate-500">and pay the highest tier reached.</span>
        <div className="flex-1" />
        <button className="btn btn-sm" onClick={() => commit([...rows, { from: '', amount: '' }])}>
          + Tier
        </button>
      </div>
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="w-24 text-right text-slate-400">metric reaches</span>
          <input className="input w-28" placeholder="100" value={r.from} onChange={(e) => commit(rows.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)))} />
          <span className="text-slate-400">pay</span>
          <input className="input w-28" placeholder="$5,000" value={r.amount} onChange={(e) => commit(rows.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
          <div className="flex-1" />
          <button className="text-slate-400 hover:text-rose-600" onClick={() => commit(rows.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
      {!rows.length && <div className="text-slate-400">No tiers. Example: reaches 100 pay $5,000 · reaches 120 pay $8,000.</div>}
      <div className="text-slate-400">Pays in the commission run that holds the last day of each period, so a whole-period bonus needs an end date.</div>
    </div>
  );
}

function PreviewTable({ preview, kind }: { preview: ProgramPreview; kind: ProgramKind }) {
  return (
    <div className="space-y-2 text-xs">
      {preview.warnings.map((w) => (
        <div key={w} className="text-amber-700">
          {w}
        </div>
      ))}
      {preview.lines.length === 0 ? (
        <div className="rounded-md border border-dashed border-slate-300 p-4 text-center text-slate-400">Nothing would pay.</div>
      ) : (
        <table className="w-full">
          <thead className="text-left text-slate-400">
            <tr className="border-b border-slate-200">
              <th className="py-1.5 pr-3 font-normal">Person</th>
              <th className="py-1.5 pr-3 font-normal">{kind === 'accelerator' ? 'Deal' : kind === 'bonus' ? 'Period' : 'Through'}</th>
              <th className="py-1.5 pr-3 text-right font-normal">{kind === 'accelerator' ? 'Dollars above threshold' : 'Metric'}</th>
              <th className="py-1.5 pr-3 text-right font-normal">Payout</th>
              <th className="py-1.5 font-normal">Note</th>
            </tr>
          </thead>
          <tbody>
            {preview.lines.map((l, i) => (
              <tr key={i} className="border-b border-slate-100">
                <td className="py-1.5 pr-3 text-slate-700">{l.payee}</td>
                <td className="py-1.5 pr-3 text-slate-500">{kind === 'spiff' ? (l.dealDate ?? '—') : (l.dealKey ?? l.dealDate ?? 'Whole period')}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{num(l.amount)}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{l.payout === null ? '—' : money(l.payout)}</td>
                <td className="py-1.5 text-slate-400">{l.note}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td className="py-1.5 pr-3 font-semibold" colSpan={3}>
                Total ({preview.totals.length} {preview.totals.length === 1 ? 'person' : 'people'})
              </td>
              <td className="py-1.5 pr-3 text-right font-semibold tabular-nums">{money(preview.totalPayout)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      )}
    </div>
  );
}
