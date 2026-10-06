import { COLUMN_TYPES, type ColumnDef, type ColumnType, type RawRow } from '@commissions/shared';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useRef } from 'react';

export interface GridRow {
  index: number;
  data: RawRow;
}

interface Props {
  columns: ColumnDef[];
  rows: GridRow[];
  sort?: { field: string; dir: 'asc' | 'desc' };
  onSort: (field: string) => void;
  onTypeChange: (field: string, type: ColumnType) => void;
  onRowClick?: (row: GridRow) => void;
  onEndReached?: () => void;
  hasMore: boolean;
  loading: boolean;
}

const TYPE_BADGE: Record<ColumnType, string> = {
  text: 'Aa',
  integer: '123',
  decimal: '1.5',
  currency: '$',
  percent: '%',
  date: '📅',
  datetime: '🕒',
  boolean: '✓',
};

const ROW_HEIGHT = 28;
const COL_WIDTH = 160;

export function DataGrid({ columns, rows, sort, onSort, onTypeChange, onRowClick, onEndReached, hasMore, loading }: Props) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  const items = virtualizer.getVirtualItems();
  const last = items[items.length - 1];
  useEffect(() => {
    if (!last || !hasMore || loading) return;
    if (last.index >= rows.length - 50) onEndReached?.();
  }, [last?.index, hasMore, loading, rows.length, onEndReached]);

  const totalWidth = 56 + columns.length * COL_WIDTH;

  return (
    <div ref={parentRef} className="h-full overflow-auto bg-white">
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
              <select
                className={`mt-0.5 w-fit rounded border-0 bg-transparent px-0 py-0 text-[10px] uppercase tracking-wide ${
                  c.type !== c.inferredType ? 'text-amber-700' : 'text-slate-400'
                }`}
                value={c.type}
                onChange={(e) => onTypeChange(c.name, e.target.value as ColumnType)}
                title={c.type !== c.inferredType ? `Overridden (inferred ${c.inferredType})` : 'Column type'}
              >
                {COLUMN_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {TYPE_BADGE[t]} {t}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>

        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {items.map((vi) => {
            const row = rows[vi.index];
            return (
              <div
                key={row.index}
                className="absolute left-0 flex w-full cursor-pointer border-b border-slate-100 text-xs hover:bg-indigo-50"
                style={{ top: vi.start, height: ROW_HEIGHT }}
                onClick={() => onRowClick?.(row)}
              >
                <div className="shrink-0 border-r border-slate-100 px-2 py-1.5 text-right text-slate-400" style={{ width: 56 }}>
                  {row.index + 1}
                </div>
                {columns.map((c) => (
                  <div key={c.name} className="shrink-0 truncate border-r border-slate-100 px-2 py-1.5" style={{ width: COL_WIDTH }} title={row.data[c.name]}>
                    {row.data[c.name]}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
        {rows.length === 0 && !loading && <div className="p-8 text-center text-sm text-slate-400">No rows match.</div>}
        {loading && <div className="p-2 text-center text-xs text-slate-400">Loading…</div>}
      </div>
    </div>
  );
}
