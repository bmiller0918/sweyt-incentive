import {
  OPERATOR_LABELS,
  RELATIVE_LABELS,
  emptyCalc,
  emptyCriteria,
  emptySummary,
  isCalcActive,
  isSummaryActive,
  listConditions,
  summaryColumns as summaryColumnsOf,
  type CalcSpec,
  type ColumnDef,
  type ColumnType,
  type Criteria,
  type Group,
  type SummarySpec,
} from '@commissions/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type CriteriaSet, type ImportDetail, type QueryResult } from '../api';
import {
  activeHeaderFields,
  clearField,
  clearHeaderFilters,
  hasAdvancedNodes,
  headerFilterLabel,
  readHeaderFilter,
  readPeriod,
  setHeaderFilter,
  setPeriod,
  type HeaderFilterState,
} from '../headerFilters';
import { PeriodBar } from './PeriodBar';
import { CalcPanel } from './CalcPanel';
import { CriteriaBuilder } from './CriteriaBuilder';
import { DataGrid, type GridRow } from './DataGrid';
import { HeaderFilterPopover } from './HeaderFilterPopover';
import { LinksPanel } from './LinksPanel';
import { SummaryGrid, groupValuesOf, type GroupState } from './SummaryGrid';
import { SummaryPanel } from './SummaryPanel';

const PAGE = 500;

function formatTotal(n: number, type: ColumnType): string {
  if (type === 'currency') return n.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
  if (type === 'percent') return `${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

interface Props {
  importId: string;
  /** Saved incentive to load on open (from the Incentives register). */
  initialSetId?: string | null;
  onDeleted: () => void;
  onRenamed: () => void;
}

export function ImportView({ importId, initialSetId, onDeleted, onRenamed }: Props) {
  const [imp, setImp] = useState<ImportDetail | null>(null);
  const [criteria, setCriteria] = useState<Criteria>(emptyCriteria);
  const [params, setParams] = useState<Record<string, string>>({});
  const [sort, setSort] = useState<{ field: string; dir: 'asc' | 'desc' } | undefined>();
  const [rows, setRows] = useState<GridRow[]>([]);
  const [meta, setMeta] = useState<Omit<QueryResult, 'rows'>>({ mode: 'detail', total: 0, matched: 0, impact: {}, errors: {}, totals: {} });
  const [viewMode, setViewMode] = useState<'detail' | 'summary'>('detail');
  const [summaryColumns, setSummaryColumns] = useState<ColumnDef[]>([]);
  const [expanded, setExpanded] = useState<Record<string, GroupState>>({});
  const [filterPopover, setFilterPopover] = useState<{ field: string; anchor: DOMRect } | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [linksOpen, setLinksOpen] = useState(false);
  const reloadImport = () => api.getImport(importId).then(setImp).catch((e) => setError(e.message));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sets, setSets] = useState<CriteriaSet[]>([]);
  const [currentSet, setCurrentSet] = useState<CriteriaSet | null>(null);
  const [explain, setExplain] = useState<{ row: GridRow; matched: boolean; conditions: Record<string, boolean> } | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const abortRef = useRef<AbortController | null>(null);

  // Names referenced by {{param}} operands, so we can show inputs for them.
  const paramNames = useMemo(() => {
    const names = new Set<string>();
    for (const c of listConditions(criteria.root)) for (const v of c.values) if (v.kind === 'param') names.add(v.name);
    return [...names];
  }, [criteria]);

  const loadSets = useCallback(() => api.listCriteriaSets(importId).then((s) => (setSets(s), s)).catch(() => [] as CriteriaSet[]), [importId]);
  const [saveDialog, setSaveDialog] = useState<{ asNew: boolean; name: string; description: string } | null>(null);

  useEffect(() => {
    api.getImport(importId).then(setImp).catch((e) => setError(e.message));
    loadSets().then((s) => {
      if (!initialSetId) return;
      const found = s.find((x) => x.id === initialSetId);
      if (found) {
        setCurrentSet(found);
        setCriteria(found.criteria);
        setParams(found.criteria.params ?? {});
        if (isSummaryActive(found.criteria.summary)) setViewMode('summary');
      } else setError('That incentive could not be found.');
    });
  }, [importId, initialSetId, loadSets]);

  const summaryOn = isSummaryActive(criteria.summary);
  const mode: 'detail' | 'summary' = viewMode === 'summary' && summaryOn ? 'summary' : 'detail';

  const runQuery = useCallback(
    async (offset: number, append: boolean) => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setLoading(true);
      try {
        const res = await api.query(importId, { criteria, params, mode, offset, limit: PAGE, sort }, ctrl.signal);
        if (ctrl.signal.aborted) return;
        const { rows: pageRows, ...rest } = res;
        setMeta(rest);
        if (res.columns) setSummaryColumns(res.columns);
        setRows((prev) => (append ? [...prev, ...pageRows] : pageRows));
        setError(null);
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setError((e as Error).message);
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    },
    [importId, criteria, params, sort, mode],
  );

  // Debounced re-query whenever criteria / params / sort / column types change.
  useEffect(() => {
    if (!imp) return;
    const t = setTimeout(() => runQuery(0, false), 250);
    return () => clearTimeout(t);
  }, [imp, runQuery]);

  // Drill-downs are only valid for the criteria they were fetched under.
  useEffect(() => {
    setExpanded({});
  }, [criteria, params, imp?.columns]);

  const toggleGroup = (row: GridRow, key: string) => {
    if (expanded[key]) {
      setExpanded((e) => {
        const { [key]: _gone, ...rest } = e;
        return rest;
      });
      return;
    }
    setExpanded((e) => ({ ...e, [key]: { loading: true } }));
    api
      .groupRows(importId, { criteria, params, groupValues: groupValuesOf(row, criteria.summary?.groupBy ?? []) })
      .then((result) => setExpanded((e) => (e[key] ? { ...e, [key]: { loading: false, result } } : e)))
      .catch((err: Error) => setExpanded((e) => (e[key] ? { ...e, [key]: { loading: false, error: err.message } } : e)));
  };

  const hasMore = rows.length < meta.matched;
  const loadMore = useCallback(() => {
    if (!loading && hasMore) runQuery(rows.length, true);
  }, [loading, hasMore, rows.length, runQuery]);

  const setRoot = (root: Group) => setCriteria((c) => ({ ...c, root }));
  const setSummary = (summary: SummarySpec) => setCriteria((c) => ({ ...c, summary }));
  const setCalc = (calc: CalcSpec) => setCriteria((c) => ({ ...c, calc }));
  const calcOn = (criteria.calc?.items.length ?? 0) > 0 || !!criteria.calc?.repField;
  const setFieldFilter = (col: ColumnDef, state: HeaderFilterState) => setRoot(setHeaderFilter(criteria.root, col, state));
  const headerFields = activeHeaderFields(criteria.root);
  const popoverColumn = filterPopover ? imp?.columns.find((c) => c.name === filterPopover.field) : undefined;
  // Anything the header filters can't express forces the advanced builder open.
  const showAdvanced = advanced || hasAdvancedNodes(criteria.root);

  // Sorting by a column that doesn't exist in the other view would be ignored
  // server-side; clear it when the view flips.
  const switchView = (m: 'detail' | 'summary') => {
    setViewMode(m);
    setSort(undefined);
  };

  const changeType = async (field: string, type: ColumnType) => {
    if (!imp) return;
    try {
      setImp(await api.patchImport(imp.id, { columns: [{ name: field, type }] }));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const toggleSort = (field: string) =>
    setSort((s) => (s?.field !== field ? { field, dir: 'asc' } : s.dir === 'asc' ? { field, dir: 'desc' } : undefined));

  const save = (asNew: boolean) =>
    setSaveDialog({
      asNew,
      name: currentSet && !asNew ? currentSet.name : '',
      description: currentSet && !asNew ? (currentSet.description ?? '') : '',
    });
  const confirmSave = async () => {
    if (!saveDialog || !saveDialog.name.trim()) return;
    try {
      const body = { name: saveDialog.name.trim(), description: saveDialog.description.trim() || null, importId, criteria };
      const saved = currentSet && !saveDialog.asNew ? await api.updateCriteriaSet(currentSet.id, body) : await api.createCriteriaSet(body);
      setCurrentSet(saved);
      setSaveDialog(null);
      await loadSets();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const loadSet = (id: string) => {
    const s = sets.find((x) => x.id === id) ?? null;
    setCurrentSet(s);
    setCriteria(s ? s.criteria : emptyCriteria());
    setParams(s?.criteria.params ?? {});
  };

  const rename = async () => {
    if (!imp) return;
    const name = window.prompt('Rename import', imp.name);
    if (!name || name === imp.name) return;
    setImp(await api.patchImport(imp.id, { name }));
    onRenamed();
  };

  const remove = async () => {
    if (!imp || !window.confirm(`Delete "${imp.name}" and its ${imp.rowCount.toLocaleString()} rows?`)) return;
    await api.deleteImport(imp.id);
    onDeleted();
  };

  const explainRow = async (row: GridRow) => {
    if (mode === 'summary' || listConditions(criteria.root).length === 0) return;
    try {
      const res = await api.explain(importId, { criteria, params, rowIndex: row.index });
      setExplain({ row, ...res });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!imp) return <div className="p-8 text-sm text-slate-400">{error ?? 'Loading…'}</div>;

  const conditionsById = Object.fromEntries(listConditions(criteria.root).map((c) => [c.id, c]));
  const gridColumns = mode === 'summary' ? summaryColumns : imp.columns;
  const totalEntries = gridColumns.filter((c) => meta.totals[c.name]).map((c) => ({ col: c, t: meta.totals[c.name] }));

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-slate-200 bg-panel px-4 py-2">
        <button className="truncate text-sm font-semibold hover:underline" onClick={rename} title="Rename">
          {imp.name}
        </button>
        <span className="text-xs text-slate-400">
          {imp.filename}
          {imp.sheetName ? ` · ${imp.sheetName}` : ''}
        </span>
        {imp.warnings.length > 0 && (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-800" title={imp.warnings.join('\n')}>
            {imp.warnings.length} warning{imp.warnings.length === 1 ? '' : 's'}
          </span>
        )}
        <button className="btn btn-sm" onClick={() => setLinksOpen(true)} title="Link this import to a parent or see its children">
          Links
          {imp.columns.some((c) => c.linked) && <span className="ml-1 rounded bg-indigo-100 px-1 text-[10px] text-indigo-700">{[...new Set(imp.columns.flatMap((c) => (c.linked ? [c.linked] : [])))].length}</span>}
        </button>
        <div className="flex-1" />
        <div className="inline-flex overflow-hidden rounded-md border border-slate-300 text-xs">
          {(['detail', 'summary'] as const).map((m) => (
            <button
              key={m}
              onClick={() => switchView(m)}
              disabled={m === 'summary' && !summaryOn}
              className={`px-2 py-1 font-medium capitalize disabled:opacity-40 ${
                mode === m ? 'bg-indigo-600 text-white' : 'bg-panel text-slate-600 hover:bg-slate-100'
              }`}
              title={m === 'summary' && !summaryOn ? 'Add a group-by or aggregate first' : undefined}
            >
              {m}
            </button>
          ))}
        </div>
        <span className="whitespace-nowrap text-sm tabular-nums">
          {mode === 'summary' ? (
            <>
              <strong>{meta.matched.toLocaleString()}</strong>{' '}
              <span className="text-slate-400">
                group{meta.matched === 1 ? '' : 's'}
                {meta.groupCount !== undefined && meta.groupCount !== meta.matched ? ` of ${meta.groupCount}` : ''} · from{' '}
                {(meta.detailMatched ?? 0).toLocaleString()} of {meta.total.toLocaleString()} rows
              </span>
            </>
          ) : (
            <>
              <strong>{meta.matched.toLocaleString()}</strong> <span className="text-slate-400">of {meta.total.toLocaleString()} rows</span>
            </>
          )}
        </span>
        <button className="btn" onClick={() => api.export(importId, { criteria, params, mode, format: 'csv' }).catch((e) => setError(e.message))}>
          Export CSV
        </button>
        <button className="btn" onClick={() => api.export(importId, { criteria, params, mode, format: 'xlsx' }).catch((e) => setError(e.message))}>
          Export XLSX
        </button>
        <button className="btn text-rose-600" onClick={remove}>
          Delete
        </button>
        <button className="btn" onClick={() => setPanelOpen((o) => !o)}>
          {panelOpen ? 'Hide criteria' : 'Show criteria'}
        </button>
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
        {/* Criteria panel */}
        {panelOpen && (
          <div className="flex w-[30rem] shrink-0 flex-col border-r border-slate-200 bg-slate-50">
            <div className="flex items-center gap-2 border-b border-slate-200 bg-panel px-3 py-2 text-xs">
              <select className="select flex-1" value={currentSet?.id ?? ''} onChange={(e) => loadSet(e.target.value)} title="Saved incentives for this import">
                <option value="">— unsaved incentive —</option>
                {sets.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} (v{s.version})
                  </option>
                ))}
              </select>
              <button className="btn btn-sm btn-primary" onClick={() => save(false)} title={currentSet ? 'Save a new version of this incentive' : 'Save as an incentive'}>
                Save
              </button>
              {currentSet && (
                <>
                  <button className="btn btn-sm" onClick={() => save(true)}>
                    Save as
                  </button>
                  <button
                    className="btn btn-sm text-rose-600"
                    onClick={async () => {
                      if (!window.confirm(`Delete incentive "${currentSet.name}"?`)) return;
                      await api.deleteCriteriaSet(currentSet.id);
                      setCurrentSet(null);
                      loadSets();
                    }}
                  >
                    ✕
                  </button>
                </>
              )}
              <button
                className="btn btn-sm"
                onClick={() => {
                  setCriteria(emptyCriteria());
                  setCurrentSet(null);
                }}
                title="Clear all conditions"
              >
                Clear
              </button>
            </div>
            {paramNames.length > 0 && (
              <div className="flex flex-wrap gap-2 border-b border-slate-200 bg-panel px-3 py-2 text-xs">
                {paramNames.map((n) => (
                  <label key={n} className="flex items-center gap-1 text-slate-600">
                    <span className="font-mono">{`{{${n}}}`}</span>
                    <input className="input w-36" value={params[n] ?? ''} onChange={(e) => setParams((p) => ({ ...p, [n]: e.target.value }))} />
                  </label>
                ))}
              </div>
            )}
            <div className="flex-1 overflow-auto p-3">
              <div className="mb-1 flex items-center text-xs">
                <span className="font-semibold text-slate-600">1 · Filter rows</span>
                <div className="flex-1" />
                <label className="inline-flex items-center gap-1 text-slate-500" title="Nested AND/OR/NOT groups, field-to-field comparisons, parameters">
                  <input type="checkbox" checked={showAdvanced} disabled={hasAdvancedNodes(criteria.root)} onChange={(e) => setAdvanced(e.target.checked)} />
                  Advanced
                </label>
              </div>
              <PeriodBar columns={imp.columns} period={readPeriod(criteria.root)} onChange={(p) => setRoot(setPeriod(criteria.root, p))} />
              {showAdvanced ? (
                <>
                  <CriteriaBuilder root={criteria.root} columns={imp.columns} impact={meta.impact} errors={meta.errors} onChange={setRoot} importId={importId} />
                  <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
                    Header filters appear here too (ids starting with <code>hf:</code>). The amber badge shows rows a condition removes; click a grid row to see why it
                    did or didn't match.
                  </p>
                </>
              ) : (
                <div className="rounded-lg border border-dashed border-slate-300 bg-panel px-3 py-2 text-[11px] leading-relaxed text-slate-500">
                  {headerFields.length === 0 ? (
                    <>
                      Click the <span className="font-semibold">funnel</span> on any column header to filter by its values or a condition. Filters on different columns
                      combine with AND.
                    </>
                  ) : (
                    <>
                      {headerFields.length} column filter{headerFields.length === 1 ? '' : 's'} active — see the chips above the grid. Tick <em>Advanced</em> for
                      OR groups, NOT, or field-to-field rules.
                    </>
                  )}
                </div>
              )}

              <div className="mt-4 mb-1 flex items-center text-xs">
                <span className="font-semibold text-slate-600">2 · Summarize</span>
                <span className="ml-2 text-slate-400">(optional)</span>
                <div className="flex-1" />
                {summaryOn ? (
                  <button className="btn btn-sm" onClick={() => setSummary(emptySummary())}>
                    Clear
                  </button>
                ) : (
                  <button
                    className="btn btn-sm"
                    onClick={() => {
                      const amount = imp.columns.find((c) => c.type === 'currency' || c.type === 'decimal' || c.type === 'integer');
                      setSummary({ groupBy: [], aggregates: amount ? [{ id: `agg${Date.now()}`, fn: 'sum', field: amount.name }] : [] });
                      switchView('summary');
                    }}
                  >
                    + Summary
                  </button>
                )}
              </div>
              {summaryOn && (
                <div className="rounded-lg border border-slate-200 bg-panel p-2">
                  <SummaryPanel spec={criteria.summary ?? emptySummary()} columns={imp.columns} errors={meta.errors} onChange={setSummary} />
                </div>
              )}

              {summaryOn && (
                <>
                  <div className="mt-4 mb-1 flex items-center text-xs">
                    <span className="font-semibold text-slate-600">3 · Calculate</span>
                    <span className="ml-2 text-slate-400">(formulas over the summary rows, with comp-plan lookup)</span>
                    <div className="flex-1" />
                    {calcOn ? (
                      <button className="btn btn-sm" onClick={() => setCalc(emptyCalc())}>
                        Clear
                      </button>
                    ) : (
                      <button
                        className="btn btn-sm"
                        onClick={() => {
                          const spec = criteria.summary ?? emptySummary();
                          const repField = spec.groupBy.find((g) => /rep|owner|sales|employee|name/i.test(g)) ?? spec.groupBy[0];
                          setCalc({ repField, items: [] });
                          switchView('summary');
                        }}
                      >
                        + Calculate
                      </button>
                    )}
                  </div>
                  {calcOn && (
                    <div className="rounded-lg border border-slate-200 bg-panel p-2">
                      <CalcPanel
                        spec={criteria.calc ?? emptyCalc()}
                        summaryColumns={summaryColumnsOf(criteria.summary ?? emptySummary(), Object.fromEntries(imp.columns.map((c) => [c.name, c.type])))}
                        errors={meta.errors}
                        noPlan={meta.calc?.noPlan}
                        asOf={meta.calc?.asOf ?? undefined}
                        onChange={setCalc}
                      />
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {/* Grid + totals */}
        <div className="flex min-w-0 flex-1 flex-col">
          {mode === 'detail' && headerFields.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-200 bg-panel px-3 py-1.5 text-xs">
              <span className="text-slate-400">Filters:</span>
              {headerFields.map((f) => {
                const col = imp.columns.find((c) => c.name === f);
                if (!col) return null;
                const st = readHeaderFilter(criteria.root, f);
                return (
                  <span key={f} className="inline-flex items-center overflow-hidden rounded-full border border-indigo-200 bg-indigo-50 text-indigo-800">
                    <button
                      className="px-2 py-0.5 hover:bg-indigo-100"
                      onClick={(e) => setFilterPopover({ field: f, anchor: e.currentTarget.getBoundingClientRect() })}
                      title="Edit filter"
                    >
                      <span className="font-semibold">{f}</span>: {headerFilterLabel(st)}
                    </button>
                    <button className="px-1.5 py-0.5 text-indigo-400 hover:bg-indigo-100 hover:text-rose-600" onClick={() => setRoot(clearField(criteria.root, f))} title="Remove">
                      ✕
                    </button>
                  </span>
                );
              })}
              <button className="ml-1 text-slate-500 hover:text-rose-600" onClick={() => setRoot(clearHeaderFilters(criteria.root))}>
                Clear all
              </button>
            </div>
          )}
          <div className="min-h-0 flex-1">
            {mode === 'summary' ? (
              <SummaryGrid
                columns={gridColumns}
                rows={rows}
                groupBy={criteria.summary?.groupBy ?? []}
                expanded={expanded}
                onToggle={toggleGroup}
                sort={sort}
                onSort={toggleSort}
                onEndReached={loadMore}
                hasMore={hasMore}
                loading={loading}
                formatTotal={formatTotal}
              />
            ) : (
              <DataGrid
                columns={gridColumns}
                rows={rows}
                sort={sort}
                onSort={toggleSort}
                onTypeChange={changeType}
                onRowClick={explainRow}
                onEndReached={loadMore}
                hasMore={hasMore}
                loading={loading}
                activeFilters={new Set(headerFields)}
                onOpenFilter={(field, anchor) => setFilterPopover((p) => (p?.field === field ? null : { field, anchor }))}
              />
            )}
          </div>
          {filterPopover && popoverColumn && (
            <HeaderFilterPopover
              importId={importId}
              column={popoverColumn}
              columns={imp.columns}
              criteria={criteria}
              params={params}
              state={readHeaderFilter(criteria.root, popoverColumn.name)}
              anchor={filterPopover.anchor}
              onChange={(st) => setFieldFilter(popoverColumn, st)}
              onClose={() => setFilterPopover(null)}
            />
          )}
          {totalEntries.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-slate-200 bg-slate-50 px-3 py-1.5 text-xs tabular-nums">
              <span className="font-semibold text-slate-500">Totals{mode === 'detail' ? ' (filtered rows)' : ' (summary rows)'}:</span>
              {totalEntries.map(({ col, t }) => (
                <span key={col.name} title={`${t.count.toLocaleString()} non-blank values`}>
                  <span className="text-slate-500">{col.name}</span> <strong>{formatTotal(t.sum, col.type)}</strong>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {linksOpen && (
        <LinksPanel
          importId={importId}
          importName={imp.name}
          ownColumns={imp.columns.filter((c) => !c.linked)}
          onChanged={() => {
            reloadImport();
            setExpanded({});
          }}
          onClose={() => setLinksOpen(false)}
        />
      )}

      {/* Save incentive dialog */}
      {saveDialog && (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/30" onClick={() => setSaveDialog(null)}>
          <div className="w-[28rem] rounded-lg bg-panel p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 text-sm font-semibold">{saveDialog.asNew || !currentSet ? 'Save incentive' : `Save new version of “${currentSet.name}”`}</div>
            <label className="block text-xs text-slate-600">
              Name
              <input
                className="input mt-1 block w-full"
                autoFocus
                value={saveDialog.name}
                placeholder="e.g. Q4 New Business commissions"
                onChange={(e) => setSaveDialog({ ...saveDialog, name: e.target.value })}
                onKeyDown={(e) => e.key === 'Enter' && confirmSave()}
              />
            </label>
            <label className="mt-2 block text-xs text-slate-600">
              Description <span className="text-slate-400">(optional)</span>
              <textarea className="input mt-1 block h-20 w-full" value={saveDialog.description} onChange={(e) => setSaveDialog({ ...saveDialog, description: e.target.value })} />
            </label>
            <div className="mt-2 text-[11px] text-slate-400">
              Saves the period, filters, summary, drill-down columns and calculations for <strong>{imp.name}</strong>. Find it later under Incentives.
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <button className="btn" onClick={() => setSaveDialog(null)}>
                Cancel
              </button>
              <button className="btn btn-primary" disabled={!saveDialog.name.trim()} onClick={confirmSave}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Explain modal */}
      {explain && (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/30" onClick={() => setExplain(null)}>
          <div className="max-h-[80vh] w-[32rem] overflow-auto rounded-lg bg-panel p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center gap-2">
              <div className="text-sm font-semibold">Row {explain.row.index + 1}</div>
              <span className={`rounded px-1.5 py-0.5 text-xs ${explain.matched ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'}`}>
                {explain.matched ? 'matches' : 'does not match'}
              </span>
              <div className="flex-1" />
              <button className="btn btn-sm" onClick={() => setExplain(null)}>
                Close
              </button>
            </div>
            <ul className="space-y-1 text-xs">
              {Object.entries(explain.conditions).map(([id, ok]) => {
                const c = conditionsById[id];
                if (!c) return null;
                const val = explain.row.data[c.field];
                return (
                  <li key={id} className={`flex items-start gap-2 rounded px-2 py-1 ${ok ? 'bg-emerald-50' : 'bg-rose-50'}`}>
                    <span>{ok ? '✓' : '✗'}</span>
                    <span>
                      <strong>{c.field}</strong> {OPERATOR_LABELS[c.operator]}{' '}
                      {c.values
                        .map((v) =>
                          v.kind === 'literal'
                            ? `"${v.value}"`
                            : v.kind === 'field'
                              ? `[${v.field}]`
                              : v.kind === 'param'
                                ? `{{${v.name}}}${params[v.name] ? ` = ${params[v.name]}` : ''}`
                                : `${RELATIVE_LABELS[v.preset]}${v.n ? ` (${v.n})` : ''}`,
                        )
                        .join(', ')}
                      <span className="text-slate-400"> · row value: {val === '' ? '(blank)' : val}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
