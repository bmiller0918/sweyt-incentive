import { LINE_STATUS_LABELS, templateProblems, type Criteria, type LineStatus } from '@commissions/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSettings } from './SettingsProvider';
import { api, type CommissionLine, type CommissionRun, type HoldReason, type ImportSummary, type PayrollTemplate, type Subledger } from '../api';
import { ImportView } from './ImportView';
import { PayrollTemplatesView } from './PayrollTemplatesView';
import { PeriodPicker } from './PeriodPicker';
import { UploadFlow } from './UploadFlow';

const money = (n: number | null | undefined) => (n === null || n === undefined ? '' : n.toLocaleString(undefined, { style: 'currency', currency: 'USD' }));
const pct = (n: number | null) => (n === null ? '' : `${Math.round(n * 10000) / 100}%`);
const num = (n: number | null) => (n === null ? '' : n.toLocaleString());
const today = () => new Date().toISOString().slice(0, 10);
const monthLabel = (ym: string) => new Date(`${ym}-01T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' });

/** The deal a line pays on, or the program for spiff / accelerator / bonus lines without one. */
const lineLabel = (l: CommissionLine) => l.dealKey ?? (l.rowIndex < 0 ? (l.planName ?? 'Incentive') : `row ${l.rowIndex + 1}`);

const pctLabel = (n: number | null) => (n === null ? '' : `${Math.round(n * 1000) / 10}%`);

/**
 * Commission Payroll: dump in the data (Imports), filter it by date and
 * summarize it, then apply payroll templates (one per employee type) to pay
 * it as a run. Runs keep their lines for holds, statements and accounting.
 */
export type PayrollTab = 'imports' | 'templates' | 'runs';
export interface PayrollNav {
  tab?: PayrollTab;
  importId?: string | null;
  /** A saved view to open on the import. */
  setId?: string | null;
  uploading?: boolean;
  runId?: string | null;
}

const TABS: { key: PayrollTab; label: string }[] = [
  { key: 'imports', label: 'Imports' },
  { key: 'templates', label: 'Payroll templates' },
  { key: 'runs', label: 'Runs' },
];

export function CommissionsView({ nav, onNavigate }: { nav: PayrollNav; onNavigate: (n: PayrollNav) => void }) {
  const [imports, setImports] = useState<ImportSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runFrom, setRunFrom] = useState<{ importId: string; criteria?: Criteria; params?: Record<string, string> } | 'pick' | null>(null);
  const tab = nav.tab ?? 'runs';

  const refreshImports = useCallback(async () => {
    try {
      const list = await api.listImports();
      setImports(list);
      return list;
    } catch (e) {
      setError((e as Error).message);
      return [];
    }
  }, []);
  useEffect(() => {
    refreshImports();
  }, [refreshImports]);

  const openImport = (importId: string | null) => onNavigate({ tab: 'imports', importId });
  const openUpload = () => onNavigate({ tab: 'imports', uploading: true });
  const selectedImport = tab === 'imports' && !nav.uploading ? (nav.importId ?? imports?.[0]?.id ?? null) : null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-end gap-1 border-b border-slate-200 bg-panel px-4 pt-2 text-sm">
        <div className="mr-4 pb-2">
          <div className="text-[11px] text-slate-400">Payouts</div>
          <div className="font-semibold">Commission Payroll</div>
        </div>
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`-mb-px border-b-2 px-3 py-2 ${tab === t.key ? 'border-indigo-600 font-semibold text-slate-900' : 'border-transparent text-slate-500 hover:text-slate-800'}`}
            onClick={() => onNavigate({ tab: t.key })}
          >
            {t.label}
          </button>
        ))}
      </div>
      {error && (
        <div className="border-b border-red-200 bg-red-50 px-4 py-1.5 text-xs text-red-700">
          {error}{' '}
          <button className="underline" onClick={() => setError(null)}>
            dismiss
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {tab === 'imports' && imports && (
          <>
            <aside className="flex w-56 shrink-0 flex-col border-r border-slate-200 bg-panel">
              <div className="flex items-center border-b border-slate-200 px-3 py-2">
                <span className="text-sm font-semibold">Imports</span>
                <div className="flex-1" />
                <button className="btn btn-sm btn-primary" onClick={openUpload}>
                  + New import
                </button>
              </div>
              <div className="flex-1 overflow-auto p-2">
                {imports.map((imp) => (
                  <button
                    key={imp.id}
                    onClick={() => openImport(imp.id)}
                    className={`block w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-slate-100 ${selectedImport === imp.id ? 'bg-indigo-50 text-indigo-700' : 'text-slate-700'}`}
                  >
                    <div className="truncate font-medium">{imp.name}</div>
                    <div className="truncate text-xs text-slate-400">
                      {imp.rowCount.toLocaleString()} rows · {new Date(imp.createdAt).toLocaleDateString()}
                    </div>
                  </button>
                ))}
                {imports.length === 0 && <div className="px-2 py-4 text-xs text-slate-400">No imports yet. Export what you need from your CRM or ERP and drop it in.</div>}
              </div>
            </aside>
            <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
              {nav.uploading || !selectedImport ? (
                <div className="flex-1 overflow-auto">
                  <UploadFlow
                    onDone={async (imp) => {
                      await refreshImports();
                      openImport(imp.id);
                    }}
                    onCancel={imports.length ? () => openImport(imports[0].id) : undefined}
                  />
                </div>
              ) : (
                <ImportView
                  key={`${selectedImport}:${nav.setId ?? ''}`}
                  importId={selectedImport}
                  initialSetId={nav.setId ?? null}
                  onRunPayroll={(criteria, params) => setRunFrom({ importId: selectedImport, criteria, params })}
                  onDeleted={async () => {
                    const list = await refreshImports();
                    if (list.length) openImport(list[0].id);
                    else openUpload();
                  }}
                  onRenamed={refreshImports}
                />
              )}
            </main>
          </>
        )}

        {tab === 'templates' && <PayrollTemplatesView onError={setError} />}

        {tab === 'runs' && <RunsTab runId={nav.runId ?? null} onOpenRun={(id) => onNavigate({ tab: 'runs', runId: id })} onNewRun={() => setRunFrom('pick')} onImports={() => onNavigate({ tab: 'imports' })} onError={setError} />}
      </div>

      {runFrom && imports && (
        <RunPayrollDialog
          imports={imports}
          source={runFrom === 'pick' ? null : runFrom}
          onTemplates={() => {
            setRunFrom(null);
            onNavigate({ tab: 'templates' });
          }}
          onClose={() => setRunFrom(null)}
          onCreated={(run) => {
            setRunFrom(null);
            onNavigate({ tab: 'runs', runId: run.id });
          }}
        />
      )}
    </div>
  );
}

// -- Runs ----------------------------------------------------------------------

function RunsTab({ runId, onOpenRun, onNewRun, onImports, onError }: { runId: string | null; onOpenRun: (id: string) => void; onNewRun: () => void; onImports: () => void; onError: (m: string) => void }) {
  const [runs, setRuns] = useState<CommissionRun[] | null>(null);
  const [reasons, setReasons] = useState<HoldReason[]>([]);
  const [run, setRun] = useState<(CommissionRun & { lines: CommissionLine[] }) | null>(null);
  const [showReasons, setShowReasons] = useState(false);

  const refresh = useCallback(async () => {
    const r = await api.listCommissionRuns();
    setRuns(r);
    return r;
  }, []);
  const refreshReasons = useCallback(() => api.listHoldReasons().then(setReasons), []);
  useEffect(() => {
    Promise.all([refresh(), refreshReasons()]).catch((e) => onError(e.message));
  }, [refresh, refreshReasons, onError]);

  // A run deleted elsewhere (or just now) falls back to the newest.
  const selectedId = runs?.some((r) => r.id === runId) ? runId : (runs?.[0]?.id ?? null);
  const loadRun = useCallback((id: string) => api.getCommissionRun(id).then(setRun).catch((e) => onError(e.message)), [onError]);
  useEffect(() => {
    if (!selectedId) {
      setRun(null);
      return;
    }
    loadRun(selectedId);
  }, [selectedId, loadRun]);

  const remove = async (r: CommissionRun) => {
    if (!window.confirm(`Delete run "${r.name}" and its ${r.lineCount} lines?`)) return;
    await api.deleteCommissionRun(r.id);
    const list = await refresh();
    if (list[0]) onOpenRun(list[0].id);
  };

  return (
    <>
      <aside className="flex w-64 shrink-0 flex-col border-r border-slate-200 bg-panel">
        <div className="flex items-center border-b border-slate-200 px-3 py-2">
          <span className="text-sm font-semibold">Commission runs</span>
          <div className="flex-1" />
          <button className="btn btn-sm btn-primary" onClick={onNewRun}>
            + New run
          </button>
        </div>
        <div className="flex-1 overflow-auto p-2">
          {(runs ?? []).map((r) => (
            <button
              key={r.id}
              onClick={() => onOpenRun(r.id)}
              className={`block w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-slate-100 ${selectedId === r.id ? 'bg-indigo-50 text-indigo-700' : 'text-slate-700'}`}
            >
              <div className="truncate font-medium">{r.name}</div>
              <div className="truncate text-xs text-slate-400">
                {money(r.totalPayout)} · {r.dealCount} deals · {new Date(r.createdAt).toLocaleDateString()}
              </div>
            </button>
          ))}
          {runs?.length === 0 && <div className="px-2 py-4 text-xs text-slate-400">No runs yet.</div>}
        </div>
        <div className="border-t border-slate-200 p-2">
          <button className="block w-full rounded-md px-2 py-1.5 text-left text-sm text-slate-600 hover:bg-slate-100" onClick={() => setShowReasons((v) => !v)}>
            <div className="font-medium">Hold reasons</div>
            <div className="text-xs text-slate-400">{reasons.length} configured</div>
          </button>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {showReasons && <HoldReasonsPanel reasons={reasons} onChange={refreshReasons} onClose={() => setShowReasons(false)} onError={onError} />}
        {run && selectedId === run.id ? (
          <RunDetail
            run={run}
            reasons={reasons}
            onChanged={() => loadRun(run.id)}
            onDelete={() => remove(run)}
            onError={onError}
          />
        ) : (
          runs?.length === 0 && (
            <div className="m-6 max-w-xl rounded-lg border border-dashed border-slate-300 bg-panel p-6 text-sm text-slate-500">
              No runs yet. Bring in your deals under{' '}
              <button className="underline" onClick={onImports}>
                Imports
              </button>
              , filter them to the payroll period, then use <em>Run payroll</em> to apply your payroll templates.
            </div>
          )
        )}
      </main>
    </>
  );
}

// -- Run payroll -----------------------------------------------------------------

/**
 * Apply payroll templates to an import. From the Imports tab it pays the rows
 * on screen (the date filter and any column filters); from Runs it asks for
 * the import and a close-date range.
 */
function RunPayrollDialog({
  imports,
  source,
  onClose,
  onCreated,
  onTemplates,
}: {
  imports: ImportSummary[];
  source: { importId: string; criteria?: Criteria; params?: Record<string, string> } | null;
  onClose: () => void;
  onCreated: (run: CommissionRun) => void;
  onTemplates: () => void;
}) {
  const { settings } = useSettings();
  const [templates, setTemplates] = useState<PayrollTemplate[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [importId, setImportId] = useState(source?.importId ?? imports[0]?.id ?? '');
  const [from, setFrom] = useState<string | null>(settings.general.goLiveDate);
  const [to, setTo] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [payLag, setPayLag] = useState(settings.general.defaultPayLagMonths);
  const [includePrograms, setIncludePrograms] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listPayrollTemplates()
      .then((ts) => {
        setTemplates(ts);
        setPicked(new Set(ts.filter((t) => !templateProblems(t.definition, t.employeeTypeId).length).map((t) => t.id)));
      })
      .catch((e) => setError(e.message));
  }, []);

  const imp = imports.find((i) => i.id === importId);
  const filters = source?.criteria?.root.children.length ?? 0;

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const run = await api.createCommissionRun({
        name: name.trim() || `${imp?.name ?? 'Commission'} payroll`,
        importId,
        templateIds: (templates ?? []).filter((t) => picked.has(t.id)).map((t) => t.id),
        ...(source?.criteria ? { criteria: { ...source.criteria, summary: undefined, calc: undefined }, params: source.params } : { from, to }),
        payLagMonths: payLag,
        includePrograms,
      });
      onCreated(run);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div className="max-h-[90vh] w-[36rem] max-w-[95vw] overflow-auto rounded-lg bg-panel p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="text-sm font-semibold">Run payroll</div>
        <div className="mt-1 text-xs text-slate-500">
          Each template pays its employee type one line per person per deal, at the rate from their plan in force on the close date. Lines then pay on the next payroll unless a
          hold rule puts them on hold.
        </div>

        <div className="mt-3 space-y-3">
          <label className="block text-sm">
            <span className="text-xs text-slate-500">Name</span>
            <input className="input mt-1 w-full" value={name} placeholder={`${imp?.name ?? 'Commission'} payroll`} onChange={(e) => setName(e.target.value)} />
          </label>
          {source ? (
            <div className="rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600">
              Pays the rows on screen in <strong>{imp?.name}</strong>
              {filters ? `, after its ${filters} filter${filters === 1 ? '' : 's'} (including the date filter)` : ' (no filters, so every row)'}.
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-sm">
                <span className="text-xs text-slate-500">Import</span>
                <select className="select mt-1 w-full" value={importId} onChange={(e) => setImportId(e.target.value)}>
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
                  <PeriodPicker
                    from={from}
                    to={to}
                    onChange={(f, t) => {
                      setFrom(f);
                      setTo(t);
                    }}
                    compact
                  />
                </div>
              </label>
            </div>
          )}

          <div>
            <div className="text-xs text-slate-500">Payroll templates</div>
            {templates === null ? (
              <div className="mt-1 text-xs text-slate-400">Loading…</div>
            ) : templates.length === 0 ? (
              <div className="mt-1 rounded-md border border-dashed border-slate-300 p-3 text-xs text-slate-500">
                No payroll templates yet.{' '}
                <button className="underline" onClick={onTemplates}>
                  Create one per employee type
                </button>{' '}
                first.
              </div>
            ) : (
              <div className="mt-1 divide-y divide-slate-100 rounded-md border border-slate-200">
                {templates.map((t) => {
                  const problems = templateProblems(t.definition, t.employeeTypeId);
                  return (
                    <label key={t.id} className={`flex items-start gap-2 px-3 py-2 text-sm ${problems.length ? 'text-slate-400' : ''}`} title={problems.join(' ')}>
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        disabled={problems.length > 0}
                        checked={picked.has(t.id)}
                        onChange={(e) => {
                          const next = new Set(picked);
                          if (e.target.checked) next.add(t.id);
                          else next.delete(t.id);
                          setPicked(next);
                        }}
                      />
                      <span>
                        <span className="font-medium">{t.name}</span>
                        <span className="block text-xs text-slate-400">
                          {problems.length ? problems.join(' ') : t.definition.crediting === 'all' ? 'All deals' : `Own deals · ${t.definition.creditField}`}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>

          <label className="flex items-center gap-2 text-xs text-slate-600">
            <input type="checkbox" checked={includePrograms} onChange={(e) => setIncludePrograms(e.target.checked)} />
            Also pay spiffs, accelerators and bonuses whose time period overlaps this run (each reads its own import)
          </label>
          <label className="block text-sm">
            <span className="text-xs text-slate-500">Pay on the payroll this many months after the close (or the release)</span>
            <input type="number" min={0} max={12} className="input mt-1 w-24" value={payLag} onChange={(e) => setPayLag(Math.max(0, Math.min(12, Number(e.target.value) || 0)))} />
          </label>
          {error && <div className="rounded bg-red-50 px-2 py-1 text-xs text-red-700">{error}</div>}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || !importId || picked.size === 0} onClick={create}>
            {busy ? 'Calculating…' : 'Calculate'}
          </button>
        </div>
      </div>
    </div>
  );
}

// -- Run detail ----------------------------------------------------------------

function RunDetail({ run, reasons, onChanged, onDelete, onError }: { run: CommissionRun & { lines: CommissionLine[] }; reasons: HoldReason[]; onChanged: () => void; onDelete: () => void; onError: (m: string) => void }) {
  const { feature, quick } = useSettings();
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
      // Spiff / accelerator / bonus lines (rowIndex < 0) add pay, not deals.
      if (l.rowIndex >= 0 && !t.deals.has(l.rowIndex)) {
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
      t.deals.add(lineLabel(l));
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
        (!q || `${l.payee} ${l.dealKey ?? ''} ${l.planName ?? ''} ${l.component ?? ''} ${l.note ?? ''} ${reasonName(l.holdReason)}`.toLowerCase().includes(q)),
    );
  }, [run, filter, onlySplit, statusFilter, reasons]);

  const hasComponents = run.lines.some((l) => l.component);
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
            {run.importName}
            {run.config.templates?.length
              ? ` · ${run.config.templates.map((t) => t.name).join(', ')}${run.config.filtered ? ' · screen filters' : ''}`
              : ` · ${run.config.repField}${run.config.payees.length ? ` + ${run.config.payees.map((p) => p.role).join(', ')}` : ''} · ${run.config.amountField}`}
            {run.config.from || run.config.to ? ` · ${run.config.from ?? '…'} → ${run.config.to ?? '…'}` : ' · all dates'} · {run.config.holdRules?.length ?? 0} hold rule
            {(run.config.holdRules?.length ?? 0) === 1 ? '' : 's'} · {new Date(run.createdAt).toLocaleString()}
          </div>
        </div>
        <div className="flex-1" />
        {feature('accounting') && (
          <div className="flex rounded-md border border-slate-300 text-xs">
            <button className={`px-2.5 py-1 ${tab === 'lines' ? 'bg-indigo-600 text-slate-50' : 'text-slate-600 hover:bg-slate-50'}`} onClick={() => setTab('lines')}>
              Lines & holds
            </button>
            <button className={`px-2.5 py-1 ${tab === 'accounting' ? 'bg-indigo-600 text-slate-50' : 'text-slate-600 hover:bg-slate-50'}`} onClick={() => setTab('accounting')}>
              Accounting
            </button>
          </div>
        )}
        {quick('exportLines') && (
          <button className="btn btn-sm" onClick={() => api.exportCommissionRun(run.id)}>
            Export CSV
          </button>
        )}
        {quick('deleteRun') && (
          <button className="btn btn-sm" onClick={onDelete}>
            Delete
          </button>
        )}
      </div>

      {tab === 'accounting' && feature('accounting') ? (
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
              {quick('exportOnHold') && (
                <button className="btn btn-sm" onClick={() => api.exportCommissionRun(run.id, 'hold')}>
                  Export on-hold CSV
                </button>
              )}
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
                {quick('holdLines') && selectedPayable.length > 0 && (
                  <button className="btn btn-sm" onClick={() => setHoldTarget(selectedPayable)}>
                    Hold {selectedPayable.length}…
                  </button>
                )}
                {quick('releaseLines') && selectedHeld.length > 0 && (
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
                {hasComponents && <th className="py-1.5 pr-3 font-normal">Component</th>}
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
                  <td className="py-1 pr-3 whitespace-nowrap">{lineLabel(l)}</td>
                  <td className="py-1 pr-3 whitespace-nowrap">{l.dealDate ?? ''}</td>
                  <td className="py-1 pr-3 text-right">{money(l.dealAmount)}</td>
                  <td className="py-1 pr-3 whitespace-nowrap font-medium text-slate-800">{l.payee}</td>
                  <td className="py-1 pr-3">{l.role}</td>
                  <td className="py-1 pr-3">{l.planName ?? ''}</td>
                  {hasComponents && <td className="py-1 pr-3 whitespace-nowrap">{l.component ?? ''}</td>}
                  <td className="py-1 pr-3 whitespace-nowrap">
                    {l.method === 'flat' ? 'flat' : l.method === 'none' ? '' : l.method === 'margin' ? (l.tierFrom === null ? `GM below ${pctLabel(l.tierTo)}` : `GM ${pctLabel(l.tierFrom)}+`) : l.method === 'spiff' || l.method === 'bonus' ? l.method : l.method === 'accelerator' ? `above ${num(l.tierFrom)}` : `${num(l.tierFrom)} – ${l.tierTo === null ? '∞' : num(l.tierTo)}`}
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
                        {quick('releaseLines') && (
                          <button className="text-indigo-600 hover:underline" onClick={() => act(() => api.releaseLines(run.id, { lineIds: [l.id], releasedAt: releaseDate }))}>
                            Release
                          </button>
                        )}{' '}
                        {quick('payNow') && (
                          <button className="text-slate-400 hover:underline" title="Clear the hold and pay as if it was never held" onClick={() => act(() => api.payLines(run.id, [l.id]))}>
                            Undo
                          </button>
                        )}
                      </>
                    ) : l.payout === null || !quick('holdLines') ? null : (
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
  const { quick } = useSettings();
  const [data, setData] = useState<Subledger | null>(null);

  const load = useCallback(() => api.getAccounting(run.id).then(setData).catch((e) => onError(e.message)), [run.id, onError]);
  useEffect(() => {
    load();
  }, [load, run]);

  const months = useMemo(() => (data ? [...new Set(data.accrual.map((c) => c.payMonth))].sort() : []), [data]);
  const depts = useMemo(() => (data ? [...new Set(data.accrual.map((c) => c.department))].sort() : []), [data]);
  const cell = (m: string, d: string) => data?.accrual.find((c) => c.payMonth === m && c.department === d);
  const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;
  const capTotal = data ? sum(data.accrual.map((c) => c.capitalized)) : 0;
  const expTotal = data ? sum(data.accrual.map((c) => c.expensed)) : 0;
  const closing = data?.rollforward.length ? data.rollforward[data.rollforward.length - 1].closing : 0;
  const thisMonth = new Date().toISOString().slice(0, 7);
  const currentRow = data?.rollforward.find((r) => r.month === thisMonth);

  if (!data) return <div className="p-6 text-sm text-slate-400">Loading…</div>;

  return (
    <div className="flex-1 overflow-auto">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-slate-50 px-4 py-2 text-xs">
        <span className="text-slate-500">
          A preview of this run alone. Treatment and method come from each role's amortization type (Accounting › Amortization Types); the books are kept by Process Monthly Accounting.
        </span>
        <div className="flex-1" />
        {quick('exportSchedule') && (
          <button className="btn btn-sm" onClick={() => api.exportAccounting(run.id, 'schedule')}>
            Export amortization schedule
          </button>
        )}
        {quick('exportEntries') && (
          <button className="btn btn-sm" onClick={() => api.exportAccounting(run.id, 'entries')}>
            Export journal entries
          </button>
        )}
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
