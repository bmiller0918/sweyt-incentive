import type { ColumnDef, ColumnType } from '@commissions/shared';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef } from 'react';
import type { GroupRowsResult } from '../api';
import type { GridRow } from './DataGrid';

export interface GroupState {
  loading: boolean;
  result?: GroupRowsResult;
  error?: string;
}

interface Props {
  columns: ColumnDef[];
  rows: GridRow[];
  groupBy: string[];
  expanded: Record<string, GroupState>;
  onToggle: (row: GridRow, key: string) => void;
  sort?: { field: string; dir: 'asc' | 'desc' };
  onSort: (field: string) => void;
  onEndReached?: () => void;
  hasMore: boolean;
  loading: boolean;
  formatTotal: (n: number, type: ColumnType) => string;
}

/** Stable identity for a summary row: its group-by values. */
export function groupKeyOf(row: GridRow, groupBy: string[]): string {
  return JSON.stringify(groupBy.map((g) => row.data[g] ?? ''));
}

export function groupValuesOf(row: GridRow, groupBy: string[]): Record<string, string> {
  return Object.fromEntries(groupBy.map((g) => [g, row.data[g] ?? '']));
}

type Item =
  | { kind: 'group'; row: GridRow; key: string; open: boolean }
  | { kind: 'dheader'; cols: ColumnDef[] }
  | { kind: 'detail'; row: GridRow; cols: ColumnDef[] }
  | { kind: 'subtotal'; cols: ColumnDef[]; result: GroupRowsResult }
  | { kind: 'note'; text: string };

const ROW_HEIGHT = 28;
const COL_WIDTH = 160;
const INDENT = 36;

export function SummaryGrid({ columns, rows, groupBy, expanded, onToggle, sort, onSort, onEndReached, hasMore, loading, formatTotal }: Props) {
  const parentRef = useRef<HTMLDivElement>(null);

  // Flatten summary rows plus the expanded drill-downs into one fixed-height list.
  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    for (const row of rows) {
      const key = groupKeyOf(row, groupBy);
      const st = expanded[key];
      out.push({ kind: 'group', row, key, open: !!st });
      if (!st) continue;
      if (st.loading) out.push({ kind: 'note', text: 'Loading…' });
      else if (st.error) out.push({ kind: 'note', text: st.error });
      else if (st.result) {
        const cols = st.result.columns;
        out.push({ kind: 'dheader', cols });
        for (const r of st.result.rows) out.push({ kind: 'detail', row: r, cols });
        out.push({ kind: 'subtotal', cols, result: st.result });
      }
    }
    return out;
  }, [rows, expanded, groupBy]);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });
  const vItems = virtualizer.getVirtualItems();
  const last = vItems[vItems.length - 1];
  useEffect(() => {
    if (!last || !hasMore || loading) return;
    if (last.index >= items.length - 50) onEndReached?.();
  }, [last?.index, hasMore, loading, items.length, onEndReached]);

  const maxDetailCols = Math.max(0, ...Object.values(expanded).map((s) => s.result?.columns.length ?? 0));
  const totalWidth = Math.max(56 + columns.length * COL_WIDTH, 56 + INDENT + maxDetailCols * COL_WIDTH);

  return (
    <div ref={parentRef} className="h-full overflow-auto bg-panel">
      <div style={{ width: totalWidth, position: 'relative' }}>
        <div className="sticky top-0 z-10 flex border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-600" style={{ height: 40 }}>
          <div className="shrink-0 border-r border-slate-200 px-2 py-2 text-right text-slate-400" style={{ width: 56 }}>
            #
          </div>
          {columns.map((c) => (
            <div key={c.name} className="flex shrink-0 flex-col justify-center border-r border-slate-200 px-2" style={{ width: COL_WIDTH }}>
              <button className="flex items-center gap-1 truncate text-left hover:text-indigo-700" onClick={() => onSort(c.name)} title={c.name}>
                <span className="truncate">{c.name}</span>
                {sort?.field === c.name && <span className="text-indigo-600">{sort.dir === 'asc' ? '▲' : '▼'}</span>}
              </button>
              <span className="mt-0.5 text-[10px] uppercase tracking-wide text-slate-400">{c.type}</span>
            </div>
          ))}
        </div>

        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {vItems.map((vi) => {
            const it = items[vi.index];
            const style = { top: vi.start, height: ROW_HEIGHT } as const;
            switch (it.kind) {
              case 'group':
                return (
                  <div
                    key={`g${it.key}`}
                    className={`absolute left-0 flex w-full cursor-pointer border-b border-slate-100 text-xs ${it.open ? 'bg-indigo-50 font-medium' : 'hover:bg-indigo-50'}`}
                    style={style}
                    onClick={() => onToggle(it.row, it.key)}
                  >
                    <div className="flex shrink-0 items-center gap-1 border-r border-slate-100 px-2 text-slate-400" style={{ width: 56 }}>
                      <span className="w-3 text-indigo-600">{it.open ? '▾' : '▸'}</span>
                      <span className="flex-1 text-right">{it.row.index + 1}</span>
                    </div>
                    {columns.map((c) => (
                      <div key={c.name} className="shrink-0 truncate border-r border-slate-100 px-2 py-1.5" style={{ width: COL_WIDTH }} title={it.row.data[c.name]}>
                        {it.row.data[c.name]}
                      </div>
                    ))}
                  </div>
                );
              case 'dheader':
                return (
                  <div key={`h${vi.index}`} className="absolute left-0 flex w-full border-b border-slate-200 bg-slate-50 text-[11px] font-medium uppercase tracking-wide text-slate-500" style={style}>
                    <div className="shrink-0" style={{ width: 56 + INDENT }} />
                    {it.cols.map((c) => (
                      <div key={c.name} className="shrink-0 truncate px-2 py-2" style={{ width: COL_WIDTH }}>
                        {c.name}
                      </div>
                    ))}
                  </div>
                );
              case 'detail':
                return (
                  <div key={`d${it.row.index}-${vi.index}`} className="absolute left-0 flex w-full border-b border-slate-100 text-xs text-slate-700" style={style}>
                    <div className="shrink-0 pr-2 text-right text-slate-300" style={{ width: 56 + INDENT }}>
                      {it.row.index + 1}
                    </div>
                    {it.cols.map((c) => (
                      <div key={c.name} className="shrink-0 truncate px-2 py-1.5" style={{ width: COL_WIDTH }} title={it.row.data[c.name]}>
                        {it.row.data[c.name]}
                      </div>
                    ))}
                  </div>
                );
              case 'subtotal':
                return (
                  <div key={`s${vi.index}`} className="absolute left-0 flex w-full border-b-2 border-indigo-200 bg-indigo-50/60 text-xs font-semibold" style={style}>
                    <div className="shrink-0 truncate pr-2 text-right text-[11px] font-normal text-slate-500" style={{ width: 56 + INDENT }}>
                      {it.result.rows.length < it.result.matched ? `${it.result.rows.length} of ${it.result.matched}` : 'Subtotal'}
                    </div>
                    {it.cols.map((c) => {
                      const t = it.result.subtotals[c.name];
                      return (
                        <div key={c.name} className="shrink-0 truncate px-2 py-1.5" style={{ width: COL_WIDTH }}>
                          {t ? formatTotal(t.sum, c.type) : ''}
                        </div>
                      );
                    })}
                  </div>
                );
              case 'note':
                return (
                  <div key={`n${vi.index}`} className="absolute left-0 flex w-full items-center border-b border-slate-100 text-xs text-slate-400" style={style}>
                    <div className="shrink-0" style={{ width: 56 + INDENT }} />
                    {it.text}
                  </div>
                );
            }
          })}
        </div>
        {rows.length === 0 && !loading && <div className="p-8 text-center text-sm text-slate-400">No groups match.</div>}
        {loading && <div className="p-2 text-center text-xs text-slate-400">Loading…</div>}
      </div>
    </div>
  );
}
