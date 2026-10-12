import { LINE_STATUS_LABELS, OPERATOR_LABELS, familyOf, operandArity, type Condition, type HoldRule, type LineStatus, type Operator } from '@commissions/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type AccountingPolicyRow, type CommissionLine, type CommissionRun, type HoldReason, type ImportColumn, type ImportDetail, type ImportSummary, type Subledger } from '../api';
import { PeriodPicker } from './PeriodPicker';

const money = (n: number | null | undefined) => (n === null || n === undefined ? '' : n.toLocaleString(undefined, { style: 'currency', currency: 'USD' }));
const pct = (n: number | null) => (n === null ? '' : `${Math.round(n * 10000) / 100}%`);
const num = (n: number | null) => (n === null ? '' : n.toLocaleString());
const today = () => new Date().toISOString().slice(0, 10);
const monthLabel = (ym: string) => new Date(`${ym}-01T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' });

/** Operators offered in the hold-rule editor, by column family. Enough for the usual "box not ticked" checks. */
const RULE_OPERATORS: Record<ReturnType<typeof familyOf>, Operator[]> = {
  text: ['is', 'is_not', 'contains', 'not_contains', 'empty', 'not_empty'],
  number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'empty', 'not_empty'],
  date: ['before', 'after', 'on_or_before', 'on_or_after', 'empty', 'not_empty'],
  boolean: ['is_true', 'is_false', 'empty', 'not_empty'],
};

interface Draft {
  name: string;
  importId: string;
  repField: string;
  payees: { role: string; field: string }[];
  amountField: string;
  dateField: string;
  dealKeyField: string;
  from: string | null;
  to: string | null;
  holdRules: HoldRule[];
  payLagMonths: number;
  contractStartField: string;
  termMonthsField: string;
  contractEndField: string;
}

/** Guess the obvious columns so most runs are two clicks. */
function guess(imp: ImportDetail): Pick<Draft, 'repField' | 'amountField' | 'dateField' | 'dealKeyField' | 'contractStartField' | 'termMonthsField' | 'contractEndField'> {
  const names = imp.columns.map((c) => c.name);
  const find = (re: RegExp, type?: (t: string) => boolean) => names.find((n) => re.test(n) && (!type || type(imp.columns.find((c) => c.name === n)!.type))) ?? '';
  const isNum = (t: string) => ['currency', 'decimal', 'integer'].includes(t);
  const isDate = (t: string) => t === 'date' || t === 'datetime';
  return {
    repField: find(/\b(rep|owner|salesperson|employee|ae)\b/i) || find(/rep|owner/i),
    amountField: find(/\b(acv|amount|arr|bookings?|value)\b/i, isNum) || find(/./, isNum),
    dateField: find(/close|booked|signed/i, isDate) || find(/./, isDate),
    dealKeyField: find(/\b(deal|opportunity|opp)\b.*\b(id|number|#)/i) || find(/^id$/i),
    contractStartField: find(/(subscription|contract|service).*start|start.*date|go.?live/i, isDate),
    termMonthsField: find(/term|months|duration/i, isNum),
    contractEndField: find(/(subscription|contract|service).*end|end.*date/i, isDate),
  };
}

const newRule = (reasonKey: string, field: string): HoldRule => ({
  id: `r${Math.random().toString(36).slice(2, 8)}`,
  reasonKey,
  condition: { type: 'condition', id: `c${Math.random().toString(36).slice(2, 8)}`, field, operator: 'is', values: [{ kind: 'literal', value: '' }] },
});

export function CommissionsView() {
  const [runs, setRuns] = useState<CommissionRun[]>([]);
  const [imports, setImports] = useState<ImportSummary[]>([]);
  const [reasons, setReasons] = useState<HoldReason[]>([]);
  const [selectedId, setSelectedId] = useState<string | 'new' | null>(null);
  const [run, setRun] = useState<(CommissionRun & { lines: CommissionLine[] }) | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [importDetail, setImportDetail] = useState<ImportDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showReasons, setShowReasons] = useState(false);

  const refresh = useCallback(async () => {
    const r = await api.listCommissionRuns();
    setRuns(r);
    return r;
  }, []);
  const refreshReasons = useCallback(() => api.listHoldReasons().then(setReasons), []);

  useEffect(() => {
    Promise.all([refresh(), api.listImports(), refreshReasons()])
      .then(([r, imps]) => {
        setImports(imps);
        setSelectedId(r.length ? r[0].id : 'new');
      })
      .catch((e) => setError(e.message));
  }, [refresh, refreshReasons]);

  const loadRun = useCallback((id: string) => api.getCommissionRun(id).then(setRun).catch((e) => setError(e.message)), []);
  useEffect(() => {
    if (!selectedId || selectedId === 'new') {
      setRun(null);
      return;
    }
    loadRun(selectedId);
  }, [selectedId, loadRun]);

  // A fresh draft points at the first import and guesses its columns.
  useEffect(() => {
    if (selectedId !== 'new') return;
    const first = imports[0];
    setDraft({ name: '', importId: first?.id ?? '', repField: '', payees: [], amountField: '', dateField: '', dealKeyField: '', from: null, to: null, holdRules: [], payLagMonths: 1, contractStartField: '', termMonthsField: '', contractEndField: '' });
  }, [selectedId, imports]);

  useEffect(() => {
    if (!draft?.importId) {
      setImportDetail(null);
      return;
    }
    api
      .getImport(draft.importId)
      .then((d) => {
        setImportDetail(d);
        setDraft((cur) => (cur && cur.importId === d.id && !cur.repField && !cur.amountField ? { ...cur, ...guess(d), name: cur.name || `${d.name} commissions` } : cur));
      })
      .catch((e) => setError(e.message));
  }, [draft?.importId]);

  const create = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.createCommissionRun({
        name: draft.name.trim() || 'Commission run',
        importId: draft.importId,
        repField: draft.repField,
        payees: draft.payees.filter((p) => p.role.trim() && p.field),
        amountField: draft.amountField,
        dateField: draft.dateField || null,
        dealKeyField: draft.dealKeyField || null,
        from: draft.from,
        to: draft.to,
        holdRules: draft.holdRules.filter((r) => r.condition.field),
        payLagMonths: draft.payLagMonths,
        contractStartField: draft.contractStartField || null,
        termMonthsField: draft.termMonthsField || null,
        contractEndField: draft.contractEndField || null,
      });
      await refresh();
      setSelectedId(created.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (r: CommissionRun) => {
    if (!window.confirm(`Delete run "${r.name}" and its ${r.lineCount} lines?`)) return;
    await api.deleteCommissionRun(r.id);
    const list = await refresh();
    setSelectedId(list[0]?.id ?? 'new');
  };

  return (
    <div className="flex h-full">
      <aside className="flex w-64 shrink-0 flex-col border-r border-slate-200 bg-panel">
        <div className="flex items-center border-b border-slate-200 px-3 py-2">
          <span className="text-sm font-semibold">Commission runs</span>
          <div className="flex-1" />
          <button className="btn btn-sm btn-primary" onClick={() => setSelectedId('new')}>
            + New run
          </button>
        </div>
        <div className="flex-1 overflow-auto p-2">
          {runs.map((r) => (
            <button
              key={r.id}
              onClick={() => setSelectedId(r.id)}
              className={`block w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-slate-100 ${selectedId === r.id ? 'bg-indigo-50 text-indigo-700' : 'text-slate-700'}`}
            >
              <div className="truncate font-medium">{r.name}</div>
              <div className="truncate text-xs text-slate-400">
                {money(r.totalPayout)} · {r.dealCount} deals · {new Date(r.createdAt).toLocaleDateString()}
              </div>
            </button>
          ))}
          {runs.length === 0 && <div className="px-2 py-4 text-xs text-slate-400">No runs yet.</div>}
        </div>
        <div className="border-t border-slate-200 p-2">
          <button className="block w-full rounded-md px-2 py-1.5 text-left text-sm text-slate-600 hover:bg-slate-100" onClick={() => setShowReasons((v) => !v)}>
            <div className="font-medium">Hold reasons</div>
            <div className="text-xs text-slate-400">{reasons.length} configured</div>
          </button>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {error && (
          <div className="border-b border-red-200 bg-red-50 px-4 py-1.5 text-xs text-red-700">
            {error}{' '}
            <button className="underline" onClick={() => setError(null)}>
              dismiss
            </button>
          </div>
        )}

        {showReasons && <HoldReasonsPanel reasons={reasons} onChange={refreshReasons} onClose={() => setShowReasons(false)} onError={setError} />}

        {selectedId === 'new' && draft && (
          <NewRunForm draft={draft} setDraft={setDraft} imports={imports} importDetail={importDetail} reasons={reasons} busy={busy} onCreate={create} onCancel={runs.length ? () => setSelectedId(runs[0].id) : undefined} />
        )}

        {selectedId !== 'new' && run && <RunDetail run={run} reasons={reasons} onChanged={() => loadRun(run.id)} onDelete={() => remove(run)} onError={setError} />}
      </main>
    </div>
  );
}

// -- New run form --------------------------------------------------------------

function NewRunForm({
  draft,
  setDraft,
  imports,
  importDetail,
  reasons,
  busy,
  onCreate,
  onCancel,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  imports: ImportSummary[];
  importDetail: ImportDetail | null;
  reasons: HoldReason[];
  busy: boolean;
  onCreate: () => void;
  onCancel?: () => void;
}) {
  const columns = importDetail?.columns ?? [];
  const textCols = columns.filter((c) => c.type === 'text');
  const numCols = columns.filter((c) => ['currency', 'decimal', 'integer', 'percent'].includes(c.type));
  const dateCols = columns.filter((c) => c.type === 'date' || c.type === 'datetime');

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-3xl space-y-5">
        <div>
          <div className="text-base font-semibold">New commission run</div>
          <div className="text-xs text-slate-500">
            One line per person per deal. Each person's rate comes from the comp plan in force on the deal's close date; a deal that crosses a tier is split into one
            line per band. Attainment accrues in close-date order over the deals in the run. Each line then pays on the next payroll unless a hold rule puts it on hold.
          </div>
        </div>
        {imports.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 bg-panel p-6 text-sm text-slate-400">Import a deals file first.</div>
        ) : (
          <>
            <label className="block text-sm">
              <span className="text-xs text-slate-500">Name</span>
              <input className="input mt-1 w-full" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="FY2026 commissions" />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-sm">
                <span className="text-xs text-slate-500">Deals import</span>
                <select
                  className="select mt-1 w-full"
                  value={draft.importId}
                  onChange={(e) => setDraft({ ...draft, importId: e.target.value, repField: '', amountField: '', dateField: '', dealKeyField: '', payees: [], holdRules: [], contractStartField: '', termMonthsField: '', contractEndField: '' })}
                >
                  {imports.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name} ({i.rowCount.toLocaleString()} rows)
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm">
                <span className="text-xs text-slate-500">Close date range</span>
                <div className="mt-1">
                  <PeriodPicker from={draft.from} to={draft.to} onChange={(from, to) => setDraft({ ...draft, from, to })} compact />
                </div>
              </label>
              <Field label="Rep column" value={draft.repField} onChange={(v) => setDraft({ ...draft, repField: v })} options={textCols.map((c) => c.name)} required />
              <Field label="Amount column" value={draft.amountField} onChange={(v) => setDraft({ ...draft, amountField: v })} options={numCols.map((c) => c.name)} required />
              <Field label="Close date column" value={draft.dateField} onChange={(v) => setDraft({ ...draft, dateField: v })} options={dateCols.map((c) => c.name)} />
              <Field label="Deal ID column" value={draft.dealKeyField} onChange={(v) => setDraft({ ...draft, dealKeyField: v })} options={columns.map((c) => c.name)} />
            </div>

            <div>
              <span className="text-xs text-slate-500">For amortization (optional)</span>
              <div className="mt-1 text-xs text-slate-400">Where the subscription starts and how long it runs, so capitalized commissions can amortize over the contract term.</div>
              <div className="mt-2 grid grid-cols-3 gap-3">
                <Field label="Subscription start" value={draft.contractStartField} onChange={(v) => setDraft({ ...draft, contractStartField: v })} options={dateCols.map((c) => c.name)} />
                <Field label="Term (months)" value={draft.termMonthsField} onChange={(v) => setDraft({ ...draft, termMonthsField: v })} options={numCols.map((c) => c.name)} />
                <Field label="Or subscription end" value={draft.contractEndField} onChange={(v) => setDraft({ ...draft, contractEndField: v })} options={dateCols.map((c) => c.name)} />
              </div>
            </div>

            <div>
              <div className="flex items-center">
                <span className="text-xs text-slate-500">Other people paid on each deal</span>
                <div className="flex-1" />
                <button className="btn btn-sm" onClick={() => setDraft({ ...draft, payees: [...draft.payees, { role: '', field: '' }] })}>
                  + Add
                </button>
              </div>
              <div className="mt-1 text-xs text-slate-400">E.g. a Sales Engineer or Manager column. Each gets their own line under their own plan.</div>
              {draft.payees.map((p, i) => (
                <div key={i} className="mt-2 flex items-center gap-2">
                  <input
                    className="input w-40"
                    placeholder="Role, e.g. SE"
                    value={p.role}
                    onChange={(e) => setDraft({ ...draft, payees: draft.payees.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)) })}
                  />
                  <select className="select flex-1" value={p.field} onChange={(e) => setDraft({ ...draft, payees: draft.payees.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)) })}>
                    <option value="">Pick a column…</option>
                    {textCols.map((c) => (
                      <option key={c.name} value={c.name}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  <button className="text-slate-400 hover:text-rose-600" onClick={() => setDraft({ ...draft, payees: draft.payees.filter((_, j) => j !== i) })}>
                    ✕
                  </button>
                </div>
              ))}
            </div>

            <div>
              <div className="flex items-center">
                <span className="text-xs text-slate-500">Hold rules</span>
                <div className="flex-1" />
                <button className="btn btn-sm" disabled={!columns.length || !reasons.length} onClick={() => setDraft({ ...draft, holdRules: [...draft.holdRules, newRule(reasons[0]?.key ?? 'other', columns[0]?.name ?? '')] })}>
                  + Add rule
                </button>
              </div>
              <div className="mt-1 text-xs text-slate-400">
                A deal that matches a rule starts on hold with that reason instead of paying next payroll. The first matching rule wins. Anything can still be held or
                released by hand afterwards.
              </div>
              {draft.holdRules.map((r, i) => (
                <HoldRuleRow
                  key={r.id}
                  rule={r}
                  columns={columns}
                  reasons={reasons}
                  onChange={(nr) => setDraft({ ...draft, holdRules: draft.holdRules.map((x, j) => (j === i ? nr : x)) })}
                  onRemove={() => setDraft({ ...draft, holdRules: draft.holdRules.filter((_, j) => j !== i) })}
                />
              ))}
            </div>

            <label className="block text-sm">
              <span className="text-xs text-slate-500">Pay on the payroll this many months after the close (or the release)</span>
              <input type="number" min={0} max={12} className="input mt-1 w-24" value={draft.payLagMonths} onChange={(e) => setDraft({ ...draft, payLagMonths: Math.max(0, Math.min(12, Number(e.target.value) || 0)) })} />
            </label>

            <div className="flex items-center gap-2">
              <button className="btn btn-primary" disabled={busy || !draft.importId || !draft.repField || !draft.amountField} onClick={onCreate}>
                {busy ? 'Calculating…' : 'Calculate'}
              </button>
              {onCancel && (
                <button className="btn" onClick={onCancel}>
                  Cancel
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function HoldRuleRow({ rule, columns, reasons, onChange, onRemove }: { rule: HoldRule; columns: ImportColumn[]; reasons: HoldReason[]; onChange: (r: HoldRule) => void; onRemove: () => void }) {
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

// -- Run detail ----------------------------------------------------------------

function RunDetail({ run, reasons, onChanged, onDelete, onError }: { run: CommissionRun & { lines: CommissionLine[] }; reasons: HoldReason[]; onChanged: () => void; onDelete: () => void; onError: (m: string) => void }) {
  const [filter, setFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<LineStatus | 'all' | 'unpaid'>('all');
  const [onlySplit, setOnlySplit] = useState(false);
  const [holdTarget, setHoldTarget] = useState<number[] | null>(null);
  const [holdReason, setHoldReason] = useState(reasons[0]?.key ?? 'other');
  const [holdNote, setHoldNote] = useState('');
  const [releaseDate, setReleaseDate] = useState(today());
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [tab, setTab] = useState<'lines' | 'accounting'>('lines');
  const reasonName = (k: string | null) => (k ? (reasons.find((r) => r.key === k)?.name ?? k) : '');

  useEffect(() => setSelected(new Set()), [run]);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setHoldTarget(null);
      setHoldNote('');
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const byPayee = useMemo(() => {
    const m = new Map<string, { payee: string; role: string; plan: string; deals: Set<number>; amount: number; payout: number; held: number; unpaid: number }>();
    for (const l of run.lines) {
      const k = `${l.payee.toLowerCase()}|${l.role}`;
      let t = m.get(k);
      if (!t) {
        t = { payee: l.payee, role: l.role, plan: l.planName ?? '', deals: new Set(), amount: 0, payout: 0, held: 0, unpaid: 0 };
        m.set(k, t);
      }
      if (!t.deals.has(l.rowIndex)) {
        t.deals.add(l.rowIndex);
        t.amount += l.dealAmount ?? 0;
      }
      if (l.payout === null) t.unpaid++;
      else {
        t.payout += l.payout;
        if (l.status === 'hold') t.held += l.payout;
      }
      if (!t.plan && l.planName) t.plan = l.planName;
    }
    return [...m.values()].sort((a, b) => b.payout - a.payout || a.payee.localeCompare(b.payee));
  }, [run]);

  const held = useMemo(() => run.lines.filter((l) => l.status === 'hold'), [run]);
  const heldTotal = held.reduce((a, l) => a + (l.payout ?? 0), 0);
  const byReason = useMemo(() => {
    const m = new Map<string, { amount: number; lines: number; deals: Set<string> }>();
    for (const l of held) {
      const k = l.holdReason ?? 'other';
      const t = m.get(k) ?? { amount: 0, lines: 0, deals: new Set<string>() };
      t.amount += l.payout ?? 0;
      t.lines++;
      t.deals.add(l.dealKey ?? `row ${l.rowIndex + 1}`);
      m.set(k, t);
    }
    return [...m.entries()].sort((a, b) => b[1].amount - a[1].amount);
  }, [held]);
  const byMonth = useMemo(() => {
    const m = new Map<string, { amount: number; lines: number; released: number }>();
    for (const l of run.lines) {
      if (l.status === 'hold' || l.payout === null) continue;
      const k = l.payMonth ?? 'unscheduled';
      const t = m.get(k) ?? { amount: 0, lines: 0, released: 0 };
      t.amount += l.payout;
      t.lines++;
      if (l.status === 'released') t.released += l.payout;
      m.set(k, t);
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [run]);
  const payTotal = byMonth.reduce((a, [, t]) => a + t.amount, 0);

  const visibleLines = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return run.lines.filter(
      (l) =>
        (!onlySplit || l.split) &&
        (statusFilter === 'all' || (statusFilter === 'unpaid' ? l.payout === null : l.status === statusFilter)) &&
        (!q || `${l.payee} ${l.dealKey ?? ''} ${l.planName ?? ''} ${l.note ?? ''} ${reasonName(l.holdReason)}`.toLowerCase().includes(q)),
    );
  }, [run, filter, onlySplit, statusFilter, reasons]);

  const splitCount = new Set(run.lines.filter((l) => l.split).map((l) => `${l.rowIndex}|${l.payee}`)).size;
  const unpaidCount = run.lines.filter((l) => l.payout === null).length;
  const selectedHeld = [...selected].filter((id) => run.lines.find((l) => l.id === id)?.status === 'hold');
  const selectedPayable = [...selected].filter((id) => run.lines.find((l) => l.id === id)?.status !== 'hold');

  return (
    <>
      <div className="flex items-center gap-3 border-b border-slate-200 bg-panel px-4 py-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{run.name}</div>
          <div className="truncate text-xs text-slate-400">
            {run.importName} · {run.config.repField}
            {run.config.payees.length ? ` + ${run.config.payees.map((p) => p.role).join(', ')}` : ''} · {run.config.amountField}
            {run.config.from || run.config.to ? ` · ${run.config.from ?? '…'} → ${run.config.to ?? '…'}` : ' · all dates'} · {run.config.holdRules?.length ?? 0} hold rule
            {(run.config.holdRules?.length ?? 0) === 1 ? '' : 's'} · {new Date(run.createdAt).toLocaleString()}
          </div>
        </div>
        <div className="flex-1" />
        <div className="flex rounded-md border border-slate-300 text-xs">
          <button className={`px-2.5 py-1 ${tab === 'lines' ? 'bg-indigo-600 text-slate-50' : 'text-slate-600 hover:bg-slate-50'}`} onClick={() => setTab('lines')}>
            Lines & holds
          </button>
          <button className={`px-2.5 py-1 ${tab === 'accounting' ? 'bg-indigo-600 text-slate-50' : 'text-slate-600 hover:bg-slate-50'}`} onClick={() => setTab('accounting')}>
            Accounting
          </button>
        </div>
        <button className="btn btn-sm" onClick={() => api.exportCommissionRun(run.id)}>
          Export CSV
        </button>
        <button className="btn btn-sm" onClick={onDelete}>
          Delete
        </button>
      </div>

      {tab === 'accounting' ? (
        <AccountingPanel run={run} onError={onError} />
      ) : (
      <div className="flex-1 overflow-auto">
        <div className="grid grid-cols-5 gap-3 p-4">
          <Stat label="Total calculated" value={money(run.totalPayout)} sub={`${run.dealCount.toLocaleString()} deals · ${run.lineCount.toLocaleString()} lines`} />
          <Stat label="Pay next payroll" value={money(payTotal)} sub={byMonth.length ? byMonth.map(([m, t]) => `${m === 'unscheduled' ? 'no date' : monthLabel(m)} ${money(t.amount)}`).join(' · ') : 'nothing scheduled'} />
          <Stat label="On hold" value={money(heldTotal)} sub={`${held.length} line${held.length === 1 ? '' : 's'} · ${new Set(held.map((l) => l.payee.toLowerCase())).size} people`} tone={held.length ? 'hold' : undefined} />
          <Stat label="Split by a tier" value={splitCount.toLocaleString()} sub="person-deals crossing a threshold" />
          <Stat label="Needs attention" value={unpaidCount.toLocaleString()} sub="lines with no payout" tone={unpaidCount ? 'warn' : undefined} />
        </div>

        {run.warnings.length > 0 && (
          <div className="mx-4 mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            {run.warnings.map((w, i) => (
              <div key={i}>{w}</div>
            ))}
          </div>
        )}

        {held.length > 0 && (
          <div className="mx-4 mb-4 rounded-lg border border-orange-200 bg-orange-50/50 p-3">
            <div className="flex items-center gap-2">
              <div className="text-xs font-semibold text-orange-800">On hold: {money(heldTotal)}</div>
              <div className="flex-1" />
              <button className="btn btn-sm" onClick={() => api.exportCommissionRun(run.id, 'hold')}>
                Export on-hold CSV
              </button>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-4">
              <table className="w-full text-xs">
                <thead className="text-left text-slate-400">
                  <tr>
                    <th className="py-1 font-normal">By reason</th>
                    <th className="py-1 text-right font-normal">Deals</th>
                    <th className="py-1 text-right font-normal">Lines</th>
                    <th className="py-1 text-right font-normal">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {byReason.map(([k, t]) => (
                    <tr key={k} className="border-t border-orange-100">
                      <td className="py-1">{reasonName(k)}</td>
                      <td className="py-1 text-right">{t.deals.size}</td>
                      <td className="py-1 text-right">{t.lines}</td>
                      <td className="py-1 text-right font-medium">{money(t.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <table className="w-full text-xs">
                <thead className="text-left text-slate-400">
                  <tr>
                    <th className="py-1 font-normal">By person</th>
                    <th className="py-1 text-right font-normal">Lines</th>
                    <th className="py-1 text-right font-normal">On hold</th>
                  </tr>
                </thead>
                <tbody>
                  {byPayee
                    .filter((p) => p.held)
                    .sort((a, b) => b.held - a.held)
                    .map((p) => (
                      <tr key={`${p.payee}|${p.role}`} className="border-t border-orange-100">
                        <td className="py-1">
                          <button className="hover:underline" onClick={() => { setFilter(p.payee); setStatusFilter('hold'); }}>
                            {p.payee}
                          </button>{' '}
                          <span className="text-slate-400">{p.role}</span>
                        </td>
                        <td className="py-1 text-right">{held.filter((l) => l.payee === p.payee && l.role === p.role).length}</td>
                        <td className="py-1 text-right font-medium">{money(p.held)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="px-4 pb-4">
          <div className="mb-1 text-xs font-semibold text-slate-500">By person</div>
          <table className="w-full bg-panel text-xs">
            <thead className="text-left text-slate-400">
              <tr className="border-b border-slate-200">
                <th className="py-1.5 pr-3 font-normal">Person</th>
                <th className="py-1.5 pr-3 font-normal">Role</th>
                <th className="py-1.5 pr-3 font-normal">Plan</th>
                <th className="py-1.5 pr-3 text-right font-normal">Deals</th>
                <th className="py-1.5 pr-3 text-right font-normal">Deal amount</th>
                <th className="py-1.5 pr-3 text-right font-normal">Calculated</th>
                <th className="py-1.5 pr-3 text-right font-normal">On hold</th>
                <th className="py-1.5 pr-3 text-right font-normal">Effective rate</th>
                <th className="py-1.5 text-right font-normal">Unpaid lines</th>
              </tr>
            </thead>
            <tbody>
              {byPayee.map((t) => (
                <tr key={`${t.payee}|${t.role}`} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="py-1.5 pr-3 font-medium text-slate-800">
                    <button className="hover:underline" onClick={() => setFilter(t.payee)}>
                      {t.payee}
                    </button>
                  </td>
                  <td className="py-1.5 pr-3">{t.role}</td>
                  <td className="py-1.5 pr-3">{t.plan || <span className="text-rose-600">none</span>}</td>
                  <td className="py-1.5 pr-3 text-right">{t.deals.size}</td>
                  <td className="py-1.5 pr-3 text-right">{money(t.amount)}</td>
                  <td className="py-1.5 pr-3 text-right font-medium">{money(t.payout)}</td>
                  <td className={`py-1.5 pr-3 text-right ${t.held ? 'text-orange-700' : 'text-slate-400'}`}>{t.held ? money(t.held) : '—'}</td>
                  <td className="py-1.5 pr-3 text-right">{t.amount ? pct(t.payout / t.amount) : ''}</td>
                  <td className={`py-1.5 text-right ${t.unpaid ? 'text-amber-700' : 'text-slate-400'}`}>{t.unpaid || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="px-4 pb-6">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <div className="text-xs font-semibold text-slate-500">Commission lines</div>
            {selected.size > 0 && (
              <>
                <span className="text-xs text-slate-400">{selected.size} selected</span>
                {selectedPayable.length > 0 && (
                  <button className="btn btn-sm" onClick={() => setHoldTarget(selectedPayable)}>
                    Hold {selectedPayable.length}…
                  </button>
                )}
                {selectedHeld.length > 0 && (
                  <>
                    <input type="date" className="input" value={releaseDate} onChange={(e) => setReleaseDate(e.target.value)} title="Release date" />
                    <button className="btn btn-sm btn-primary" onClick={() => act(() => api.releaseLines(run.id, { lineIds: selectedHeld, releasedAt: releaseDate }))}>
                      Release {selectedHeld.length}
                    </button>
                  </>
                )}
              </>
            )}
            <div className="flex-1" />
            <select className="select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}>
              <option value="all">All statuses</option>
              <option value="pay">Pay next payroll</option>
              <option value="hold">On hold</option>
              <option value="released">Released</option>
              <option value="unpaid">Needs attention</option>
            </select>
            <label className="flex items-center gap-1 text-xs text-slate-500">
              <input type="checkbox" checked={onlySplit} onChange={(e) => setOnlySplit(e.target.checked)} /> only split deals
            </label>
            <input className="input w-56" placeholder="Filter by person, deal, plan…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>

          {holdTarget && (
            <div className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-orange-200 bg-orange-50 px-3 py-2 text-xs">
              <span className="font-medium text-orange-800">
                Put {holdTarget.length} line{holdTarget.length === 1 ? '' : 's'} on hold
              </span>
              <select className="select" value={holdReason} onChange={(e) => setHoldReason(e.target.value)}>
                {reasons.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.name}
                  </option>
                ))}
              </select>
              <input className="input w-64" placeholder="Note (optional)" value={holdNote} onChange={(e) => setHoldNote(e.target.value)} />
              <button className="btn btn-sm btn-primary" onClick={() => act(() => api.holdLines(run.id, { lineIds: holdTarget, reasonKey: holdReason, note: holdNote || null }))}>
                Hold
              </button>
              <button className="btn btn-sm" onClick={() => setHoldTarget(null)}>
                Cancel
              </button>
            </div>
          )}

          <table className="w-full bg-panel text-xs">
            <thead className="text-left text-slate-400">
              <tr className="border-b border-slate-200">
                <th className="py-1.5 pr-2">
                  <input
                    type="checkbox"
                    checked={visibleLines.length > 0 && visibleLines.every((l) => selected.has(l.id))}
                    onChange={(e) => setSelected(e.target.checked ? new Set(visibleLines.map((l) => l.id)) : new Set())}
                  />
                </th>
                <th className="py-1.5 pr-3 font-normal">Deal</th>
                <th className="py-1.5 pr-3 font-normal">Closed</th>
                <th className="py-1.5 pr-3 text-right font-normal">Deal amount</th>
                <th className="py-1.5 pr-3 font-normal">Person</th>
                <th className="py-1.5 pr-3 font-normal">Role</th>
                <th className="py-1.5 pr-3 font-normal">Plan</th>
                <th className="py-1.5 pr-3 font-normal">Tier</th>
                <th className="py-1.5 pr-3 text-right font-normal">Amount</th>
                <th className="py-1.5 pr-3 text-right font-normal">Rate</th>
                <th className="py-1.5 pr-3 text-right font-normal">Payout</th>
                <th className="py-1.5 pr-3 font-normal">Status</th>
                <th className="py-1.5 font-normal">Note</th>
                <th className="py-1.5" />
              </tr>
            </thead>
            <tbody>
              {visibleLines.map((l) => (
                <tr key={l.id} className={`border-b border-slate-100 ${l.payout === null ? 'bg-amber-50/60' : l.status === 'hold' ? 'bg-orange-50/60' : l.split ? 'bg-indigo-50/40' : ''}`}>
                  <td className="py-1 pr-2">
                    <input
                      type="checkbox"
                      checked={selected.has(l.id)}
                      onChange={(e) => {
                        const s = new Set(selected);
                        if (e.target.checked) s.add(l.id);
                        else s.delete(l.id);
                        setSelected(s);
                      }}
                    />
                  </td>
                  <td className="py-1 pr-3 whitespace-nowrap">{l.dealKey ?? `row ${l.rowIndex + 1}`}</td>
                  <td className="py-1 pr-3 whitespace-nowrap">{l.dealDate ?? ''}</td>
                  <td className="py-1 pr-3 text-right">{money(l.dealAmount)}</td>
                  <td className="py-1 pr-3 whitespace-nowrap font-medium text-slate-800">{l.payee}</td>
                  <td className="py-1 pr-3">{l.role}</td>
                  <td className="py-1 pr-3">{l.planName ?? ''}</td>
                  <td className="py-1 pr-3 whitespace-nowrap">
                    {l.method === 'flat' ? 'flat' : l.method === 'none' ? '' : `${num(l.tierFrom)} – ${l.tierTo === null ? '∞' : num(l.tierTo)}`}
                    {l.split ? <span className="ml-1 rounded bg-indigo-100 px-1 text-[10px] text-indigo-700">split</span> : null}
                  </td>
                  <td className="py-1 pr-3 text-right">{money(l.amount)}</td>
                  <td className="py-1 pr-3 text-right">{pct(l.rate)}</td>
                  <td className="py-1 pr-3 text-right font-medium">{money(l.payout)}</td>
                  <td className="py-1 pr-3 whitespace-nowrap">
                    {l.status === 'hold' ? (
                      <span className="text-orange-700" title={l.holdNote ?? ''}>
                        On hold · {reasonName(l.holdReason)}
                        {l.heldAt ? ` · since ${l.heldAt}` : ''}
                      </span>
                    ) : l.status === 'released' ? (
                      <span className="text-emerald-700" title={`Was on hold: ${reasonName(l.holdReason)}`}>
                        Released {l.releasedAt} · pays {l.payMonth ? monthLabel(l.payMonth) : '—'}
                      </span>
                    ) : (
                      <span className="text-slate-600">
                        {LINE_STATUS_LABELS.pay}
                        {l.payMonth ? ` · ${monthLabel(l.payMonth)}` : ''}
                      </span>
                    )}
                  </td>
                  <td className={`py-1 ${l.payout === null ? 'text-amber-800' : 'text-slate-400'}`}>{l.note ?? l.holdNote ?? ''}</td>
                  <td className="py-1 whitespace-nowrap text-right">
                    {l.status === 'hold' ? (
                      <>
                        <button className="text-indigo-600 hover:underline" onClick={() => act(() => api.releaseLines(run.id, { lineIds: [l.id], releasedAt: releaseDate }))}>
                          Release
                        </button>{' '}
                        <button className="text-slate-400 hover:underline" title="Clear the hold and pay as if it was never held" onClick={() => act(() => api.payLines(run.id, [l.id]))}>
                          Undo
                        </button>
                      </>
                    ) : l.payout === null ? null : (
                      <button className="text-slate-500 hover:underline" onClick={() => setHoldTarget([l.id])}>
                        Hold…
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {visibleLines.length === 0 && (
                <tr>
                  <td colSpan={14} className="py-6 text-center text-slate-400">
                    No lines match.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      )}
    </>
  );
}

// -- Accounting ----------------------------------------------------------------

function AccountingPanel({ run, onError }: { run: CommissionRun & { lines: CommissionLine[] }; onError: (m: string) => void }) {
  const [data, setData] = useState<Subledger | null>(null);
  const [policy, setPolicy] = useState<AccountingPolicyRow | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => api.getAccounting(run.id).then(setData).catch((e) => onError(e.message)), [run.id, onError]);
  useEffect(() => {
    load();
    api.getAccountingPolicy().then(setPolicy).catch((e) => onError(e.message));
  }, [load, run, onError]);

  const savePolicy = async (p: AccountingPolicyRow) => {
    setPolicy(p);
    setSaving(true);
    try {
      await api.updateAccountingPolicy({ method: p.method, customerLifeMonths: p.customerLifeMonths, defaultTermMonths: p.defaultTermMonths });
      await load();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const months = useMemo(() => (data ? [...new Set(data.accrual.map((c) => c.payMonth))].sort() : []), [data]);
  const depts = useMemo(() => (data ? [...new Set(data.accrual.map((c) => c.department))].sort() : []), [data]);
  const cell = (m: string, d: string) => data?.accrual.find((c) => c.payMonth === m && c.department === d);
  const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;
  const capTotal = data ? sum(data.accrual.map((c) => c.capitalized)) : 0;
  const expTotal = data ? sum(data.accrual.map((c) => c.expensed)) : 0;
  const closing = data?.rollforward.length ? data.rollforward[data.rollforward.length - 1].closing : 0;
  const thisMonth = new Date().toISOString().slice(0, 7);
  const currentRow = data?.rollforward.find((r) => r.month === thisMonth);

  if (!data || !policy) return <div className="p-6 text-sm text-slate-400">Loading…</div>;

  return (
    <div className="flex-1 overflow-auto">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-slate-50 px-4 py-2 text-xs">
        <span className="font-semibold text-slate-600">Amortization policy</span>
        <select className="select" value={policy.method} onChange={(e) => savePolicy({ ...policy, method: e.target.value as AccountingPolicyRow['method'] })}>
          <option value="contract_term">Contract term, from the subscription start (current practice)</option>
          <option value="customer_life">Estimated customer life, from the pay month (practical expedient)</option>
        </select>
        {policy.method === 'customer_life' ? (
          <label className="flex items-center gap-1 text-slate-600">
            Customer life
            <input type="number" min={1} max={240} className="input w-20" value={policy.customerLifeMonths} onChange={(e) => setPolicy({ ...policy, customerLifeMonths: Number(e.target.value) || 1 })} onBlur={() => savePolicy(policy)} />
            months
          </label>
        ) : (
          <label className="flex items-center gap-1 text-slate-600">
            Default term when the deal has none
            <input type="number" min={1} max={240} className="input w-20" value={policy.defaultTermMonths} onChange={(e) => setPolicy({ ...policy, defaultTermMonths: Number(e.target.value) || 1 })} onBlur={() => savePolicy(policy)} />
            months
          </label>
        )}
        <span className="text-slate-400">Straight-line, rounded to cents. {saving ? 'Saving…' : 'Applies company-wide.'}</span>
        <div className="flex-1" />
        <button className="btn btn-sm" onClick={() => api.exportAccounting(run.id, 'schedule')}>
          Export amortization schedule
        </button>
        <button className="btn btn-sm" onClick={() => api.exportAccounting(run.id, 'entries')}>
          Export journal entries
        </button>
      </div>

      <div className="grid grid-cols-4 gap-3 p-4">
        <Stat label="To accrue (all pay months)" value={money(capTotal + expTotal)} sub={`${data.accrual.reduce((a, c) => a + c.lines, 0)} lines across ${months.length} payroll month${months.length === 1 ? '' : 's'}`} />
        <Stat label="Capitalized" value={money(capTotal)} sub={`${data.schedule.length} amortization schedules`} />
        <Stat label="Expensed when paid" value={money(expTotal)} sub={depts.filter((d) => data.accrual.some((c) => c.department === d && c.expensed)).join(', ') || 'no expensed departments'} />
        <Stat label={`Capitalized balance ${currentRow ? `at ${monthLabel(thisMonth)}` : 'at end of schedule'}`} value={money(currentRow ? currentRow.closing : closing)} sub={`${data.excluded.length} line${data.excluded.length === 1 ? '' : 's'} not booked (on hold / no payout)`} />
      </div>

      {data.warnings.length > 0 && (
        <div className="mx-4 mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {data.warnings.map((w, i) => (
            <div key={i}>{w}</div>
          ))}
        </div>
      )}

      <div className="px-4 pb-4">
        <div className="mb-1 text-xs font-semibold text-slate-500">Monthly accrual by department</div>
        <div className="mb-1 text-[11px] text-slate-400">Credit Accrued commissions for the total; debit Deferred commissions for the capitalized part and Commission expense for the expensed part.</div>
        <table className="w-full bg-panel text-xs">
          <thead className="text-left text-slate-400">
            <tr className="border-b border-slate-200">
              <th className="py-1.5 pr-3 font-normal">Department</th>
              {months.map((m) => (
                <th key={m} className="py-1.5 pr-3 text-right font-normal">
                  {monthLabel(m)}
                </th>
              ))}
              <th className="py-1.5 text-right font-normal">Total</th>
            </tr>
          </thead>
          <tbody>
            {depts.map((d) => {
              const exp = data.accrual.some((c) => c.department === d && c.expensed);
              return (
                <tr key={d} className="border-b border-slate-100">
                  <td className="py-1.5 pr-3 font-medium text-slate-800">
                    {d} <span className={`ml-1 rounded px-1 text-[10px] ${exp ? 'bg-rose-100 text-rose-700' : 'bg-emerald-100 text-emerald-700'}`}>{exp ? 'expense' : 'capitalize'}</span>
                  </td>
                  {months.map((m) => (
                    <td key={m} className="py-1.5 pr-3 text-right">
                      {money(cell(m, d)?.total ?? 0)}
                    </td>
                  ))}
                  <td className="py-1.5 text-right font-medium">{money(sum(data.accrual.filter((c) => c.department === d).map((c) => c.total)))}</td>
                </tr>
              );
            })}
            <tr className="border-t border-slate-300 font-medium">
              <td className="py-1.5 pr-3">Capitalized</td>
              {months.map((m) => (
                <td key={m} className="py-1.5 pr-3 text-right">
                  {money(sum(data.accrual.filter((c) => c.payMonth === m).map((c) => c.capitalized)))}
                </td>
              ))}
              <td className="py-1.5 text-right">{money(capTotal)}</td>
            </tr>
            <tr className="font-medium">
              <td className="py-1.5 pr-3">Expensed</td>
              {months.map((m) => (
                <td key={m} className="py-1.5 pr-3 text-right">
                  {money(sum(data.accrual.filter((c) => c.payMonth === m).map((c) => c.expensed)))}
                </td>
              ))}
              <td className="py-1.5 text-right">{money(expTotal)}</td>
            </tr>
            <tr className="border-t border-slate-300 font-semibold">
              <td className="py-1.5 pr-3">Accrue (credit liability)</td>
              {months.map((m) => (
                <td key={m} className="py-1.5 pr-3 text-right">
                  {money(sum(data.accrual.filter((c) => c.payMonth === m).map((c) => c.total)))}
                </td>
              ))}
              <td className="py-1.5 text-right">{money(capTotal + expTotal)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="grid grid-cols-2 gap-4 px-4 pb-6">
        <div>
          <div className="mb-1 text-xs font-semibold text-slate-500">Capitalized balance rollforward</div>
          <table className="w-full bg-panel text-xs">
            <thead className="text-left text-slate-400">
              <tr className="border-b border-slate-200">
                <th className="py-1.5 pr-3 font-normal">Month</th>
                <th className="py-1.5 pr-3 text-right font-normal">Opening</th>
                <th className="py-1.5 pr-3 text-right font-normal">Additions</th>
                <th className="py-1.5 pr-3 text-right font-normal">Amortization</th>
                <th className="py-1.5 text-right font-normal">Closing</th>
              </tr>
            </thead>
            <tbody>
              {data.rollforward.map((r) => (
                <tr key={r.month} className={`border-b border-slate-100 ${r.month === thisMonth ? 'bg-indigo-50/50' : ''}`}>
                  <td className="py-1 pr-3 whitespace-nowrap">{monthLabel(r.month)}</td>
                  <td className="py-1 pr-3 text-right">{money(r.opening)}</td>
                  <td className="py-1 pr-3 text-right">{r.additions ? money(r.additions) : ''}</td>
                  <td className="py-1 pr-3 text-right">{r.amortization ? money(r.amortization) : ''}</td>
                  <td className="py-1 text-right font-medium">{money(r.closing)}</td>
                </tr>
              ))}
              {data.rollforward.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-4 text-center text-slate-400">
                    Nothing capitalized yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div>
          <div className="mb-1 text-xs font-semibold text-slate-500">Amortization schedules (line level)</div>
          <table className="w-full bg-panel text-xs">
            <thead className="text-left text-slate-400">
              <tr className="border-b border-slate-200">
                <th className="py-1.5 pr-3 font-normal">Deal</th>
                <th className="py-1.5 pr-3 font-normal">Payee</th>
                <th className="py-1.5 pr-3 font-normal">Dept</th>
                <th className="py-1.5 pr-3 text-right font-normal">Amount</th>
                <th className="py-1.5 pr-3 font-normal">Booked</th>
                <th className="py-1.5 pr-3 font-normal">Amortizes</th>
                <th className="py-1.5 text-right font-normal">Per month</th>
              </tr>
            </thead>
            <tbody>
              {data.schedule.map((s) => (
                <tr key={s.lineId} className="border-b border-slate-100">
                  <td className="py-1 pr-3 whitespace-nowrap">{s.dealKey ?? `line ${s.lineId}`}</td>
                  <td className="py-1 pr-3 whitespace-nowrap">{s.payee}</td>
                  <td className="py-1 pr-3">{s.department}</td>
                  <td className="py-1 pr-3 text-right">{money(s.amount)}</td>
                  <td className="py-1 pr-3 whitespace-nowrap">{monthLabel(s.capitalizedMonth)}</td>
                  <td className="py-1 pr-3 whitespace-nowrap">
                    {monthLabel(s.startMonth)} – {monthLabel(s.endMonth)} ({s.months} mo)
                  </td>
                  <td className="py-1 text-right">{money(Math.round((s.amount / s.months) * 100) / 100)}</td>
                </tr>
              ))}
              {data.schedule.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-4 text-center text-slate-400">
                    No capitalized lines.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="px-4 pb-6">
        <div className="mb-1 text-xs font-semibold text-slate-500">Journal entries</div>
        <table className="w-full bg-panel text-xs">
          <thead className="text-left text-slate-400">
            <tr className="border-b border-slate-200">
              <th className="py-1.5 pr-3 font-normal">Month</th>
              <th className="py-1.5 pr-3 font-normal">Memo</th>
              <th className="py-1.5 pr-3 font-normal">Account</th>
              <th className="py-1.5 pr-3 font-normal">Department</th>
              <th className="py-1.5 pr-3 text-right font-normal">Debit</th>
              <th className="py-1.5 text-right font-normal">Credit</th>
            </tr>
          </thead>
          <tbody>
            {data.entries.slice(0, 60).map((e, i) =>
              e.lines.map((l, j) => (
                <tr key={`${i}-${j}`} className={`border-b border-slate-100 ${j === 0 ? 'border-t border-t-slate-200' : ''}`}>
                  <td className="py-1 pr-3 whitespace-nowrap">{j === 0 ? monthLabel(e.month) : ''}</td>
                  <td className="py-1 pr-3 text-slate-500">{j === 0 ? e.memo : ''}</td>
                  <td className={`py-1 pr-3 ${l.credit ? 'pl-6' : ''}`}>{l.account}</td>
                  <td className="py-1 pr-3">{l.department ?? ''}</td>
                  <td className="py-1 pr-3 text-right">{l.debit ? money(l.debit) : ''}</td>
                  <td className="py-1 text-right">{l.credit ? money(l.credit) : ''}</td>
                </tr>
              )),
            )}
          </tbody>
        </table>
        {data.entries.length > 60 && <div className="mt-1 text-[11px] text-slate-400">Showing the first 60 entries; export for the full list.</div>}
      </div>
    </div>
  );
}

// -- Hold reasons --------------------------------------------------------------

function HoldReasonsPanel({ reasons, onChange, onClose, onError }: { reasons: HoldReason[]; onChange: () => Promise<unknown>; onClose: () => void; onError: (m: string) => void }) {
  const [name, setName] = useState('');
  return (
    <div className="border-b border-slate-200 bg-slate-50 px-4 py-3 text-sm">
      <div className="flex items-center">
        <div className="font-semibold">Hold reasons</div>
        <div className="flex-1" />
        <button className="text-slate-400 hover:text-slate-700" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {reasons.map((r) => (
          <span key={r.id} className="inline-flex items-center gap-1 rounded-full border border-slate-300 bg-panel px-2 py-0.5 text-xs">
            {r.name}
            {!r.builtin && (
              <button
                className="text-slate-400 hover:text-rose-600"
                onClick={() =>
                  api
                    .deleteHoldReason(r.id)
                    .then(onChange)
                    .catch((e) => onError(e.message))
                }
              >
                ✕
              </button>
            )}
          </span>
        ))}
      </div>
      <form
        className="mt-2 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          api
            .createHoldReason(name)
            .then(() => {
              setName('');
              return onChange();
            })
            .catch((err) => onError(err.message));
        }}
      >
        <input className="input w-72" placeholder="New reason, e.g. Pending signed order form" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn btn-sm" type="submit">
          Add
        </button>
      </form>
    </div>
  );
}

// -- Bits ----------------------------------------------------------------------

function Field({ label, value, onChange, options, required }: { label: string; value: string; onChange: (v: string) => void; options: string[]; required?: boolean }) {
  return (
    <label className="block text-sm">
      <span className="text-xs text-slate-500">
        {label}
        {required ? '' : ' (optional)'}
      </span>
      <select className="select mt-1 w-full" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{required ? 'Pick a column…' : 'None'}</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'warn' | 'hold' }) {
  const border = tone === 'warn' ? 'border-amber-200' : tone === 'hold' ? 'border-orange-200' : 'border-slate-200';
  const text = tone === 'warn' ? 'text-amber-700' : tone === 'hold' ? 'text-orange-700' : 'text-slate-800';
  return (
    <div className={`rounded-lg border bg-panel px-3 py-2 ${border}`}>
      <div className="text-xs text-slate-400">{label}</div>
      <div className={`text-lg font-semibold ${text}`}>{value}</div>
      {sub && <div className="truncate text-[11px] text-slate-400" title={sub}>{sub}</div>}
    </div>
  );
}
