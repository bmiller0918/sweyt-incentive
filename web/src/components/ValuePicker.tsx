import { useEffect, useRef, useState } from 'react';
import { api } from '../api';

interface Props {
  importId: string;
  field: string;
  /** Checkbox list (any of / none of) vs. single choice (is / is not). */
  multiple: boolean;
  selected: string[];
  onChange: (values: string[]) => void;
}

/**
 * A dropdown of a column's distinct values, with search and counts. Typed
 * text that matches nothing can still be used as a custom value.
 */
export function ValuePicker({ importId, field, multiple, selected, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [values, setValues] = useState<{ value: string; count: number }[]>([]);
  const [meta, setMeta] = useState({ distinct: 0, truncated: false });
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    setLoading(true);
    const t = setTimeout(() => {
      api
        .values(importId, { field, search }, ctrl.signal)
        .then((r) => {
          setValues(r.values);
          setMeta({ distinct: r.distinct, truncated: r.truncated });
          setLoading(false);
        })
        .catch((e) => {
          if ((e as Error).name !== 'AbortError') setLoading(false);
        });
    }, search ? 200 : 0);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [open, importId, field, search]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const sel = new Set(selected);
  const pick = (v: string) => {
    if (multiple) {
      const next = new Set(sel);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      onChange([...next]);
    } else {
      onChange([v]);
      setOpen(false);
    }
  };
  const customCandidate = search.trim() && !values.some((v) => v.value === search.trim()) ? search.trim() : null;

  const label =
    selected.length === 0
      ? multiple
        ? 'choose values…'
        : 'choose a value…'
      : selected.length <= 2
        ? selected.map((s) => (s === '' ? '(blank)' : s)).join(', ')
        : `${selected.slice(0, 2).join(', ')} +${selected.length - 2}`;

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        className={`input flex max-w-[16rem] items-center gap-1 text-left ${selected.length ? '' : 'text-slate-400'}`}
        onClick={() => setOpen((o) => !o)}
        title={selected.join(', ')}
      >
        <span className="truncate">{label}</span>
        <span className="text-slate-400">▾</span>
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 flex max-h-72 w-72 flex-col rounded-md border border-slate-200 bg-white text-xs shadow-xl">
          <div className="flex items-center gap-2 border-b border-slate-100 p-2">
            <input
              className="input flex-1"
              placeholder="Search…"
              value={search}
              autoFocus
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && customCandidate) {
                  pick(customCandidate);
                  setSearch('');
                }
              }}
            />
            {multiple && selected.length > 0 && (
              <button className="text-slate-500 hover:text-rose-600" onClick={() => onChange([])}>
                Clear
              </button>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-1">
            {customCandidate && (
              <button className="block w-full rounded px-2 py-1 text-left text-indigo-700 hover:bg-indigo-50" onClick={() => pick(customCandidate)}>
                Use “{customCandidate}”
              </button>
            )}
            {loading && values.length === 0 && <div className="px-2 py-2 text-slate-400">Loading…</div>}
            {!loading && values.length === 0 && !customCandidate && <div className="px-2 py-2 text-slate-400">No values.</div>}
            {values.map((v) => (
              <label key={v.value} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-slate-50">
                <input type={multiple ? 'checkbox' : 'radio'} checked={sel.has(v.value)} onChange={() => pick(v.value)} />
                <span className={`flex-1 truncate ${v.value === '' ? 'italic text-slate-400' : ''}`} title={v.value}>
                  {v.value === '' ? '(blank)' : v.value}
                </span>
                <span className="tabular-nums text-slate-400">{v.count.toLocaleString()}</span>
              </label>
            ))}
          </div>
          <div className="border-t border-slate-100 px-2 py-1 text-[11px] text-slate-400">
            {meta.distinct.toLocaleString()} distinct{meta.truncated ? ' · search to find more' : ''}
            {multiple && selected.length > 0 && ` · ${selected.length} selected`}
          </div>
        </div>
      )}
    </div>
  );
}
