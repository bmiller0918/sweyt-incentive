import { useCallback, useEffect, useState } from 'react';
import { api, type ImportSummary } from './api';
import { CompPlansView } from './components/CompPlansView';
import { ImportView } from './components/ImportView';
import { UploadFlow } from './components/UploadFlow';

export default function App() {
  const [imports, setImports] = useState<ImportSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [page, setPage] = useState<'imports' | 'plans'>('imports');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
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
    refresh().then((list) => {
      if (list.length && !selected) setSelected(list[0].id);
      else if (!list.length) setUploading(true);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex h-full">
      <aside className="flex w-60 shrink-0 flex-col border-r border-slate-200 bg-white">
        <div className="border-b border-slate-200 px-4 py-3">
          <div className="text-sm font-semibold tracking-tight">Sweyt Incentive</div>
          <div className="text-xs text-slate-500">Import & Criteria</div>
        </div>
        <button
          className="btn btn-primary m-3"
          onClick={() => {
            setPage('imports');
            setUploading(true);
            setSelected(null);
          }}
        >
          + New import
        </button>
        <nav className="flex-1 overflow-y-auto px-2 pb-2">
          {imports.length === 0 && <div className="px-2 py-4 text-xs text-slate-400">No imports yet.</div>}
          {imports.map((imp) => (
            <button
              key={imp.id}
              onClick={() => {
                setPage('imports');
                setSelected(imp.id);
                setUploading(false);
              }}
              className={`block w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-slate-100 ${
                page === 'imports' && selected === imp.id && !uploading ? 'bg-indigo-50 text-indigo-700' : 'text-slate-700'
              }`}
            >
              <div className="truncate font-medium">{imp.name}</div>
              <div className="truncate text-xs text-slate-400">
                {imp.rowCount.toLocaleString()} rows · {new Date(imp.createdAt).toLocaleDateString()}
              </div>
            </button>
          ))}
        </nav>
        <div className="border-t border-slate-200 p-2">
          <button
            onClick={() => setPage('plans')}
            className={`block w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-slate-100 ${page === 'plans' ? 'bg-indigo-50 text-indigo-700' : 'text-slate-700'}`}
          >
            <div className="font-medium">Comp plans</div>
            <div className="text-xs text-slate-400">rates, quotas, rep assignments</div>
          </button>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        {error && (
          <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
            {error}{' '}
            <button className="underline" onClick={() => setError(null)}>
              dismiss
            </button>
          </div>
        )}
        {page === 'plans' ? (
          <CompPlansView />
        ) : uploading || !selected ? (
          <UploadFlow
            onDone={async (imp) => {
              await refresh();
              setSelected(imp.id);
              setUploading(false);
            }}
            onCancel={imports.length ? () => setUploading(false) : undefined}
          />
        ) : (
          <ImportView
            key={selected}
            importId={selected}
            onDeleted={async () => {
              const list = await refresh();
              setSelected(list[0]?.id ?? null);
              if (!list.length) setUploading(true);
            }}
            onRenamed={refresh}
          />
        )}
      </main>
    </div>
  );
}
