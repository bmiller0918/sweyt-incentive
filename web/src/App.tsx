import { useCallback, useEffect, useState } from 'react';
import { api, type ImportSummary } from './api';
import { CompPlansView } from './components/CompPlansView';
import { EmployeeTypesView } from './components/EmployeeTypesView';
import { EmployeesView } from './components/EmployeesView';
import { IncentivesView } from './components/IncentivesView';
import { ImportView } from './components/ImportView';
import { UploadFlow } from './components/UploadFlow';

export default function App() {
  const [imports, setImports] = useState<ImportSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [page, setPage] = useState<'imports' | 'plans' | 'employees' | 'types' | 'incentives'>('imports');
  const [peopleOpen, setPeopleOpen] = useState(false);
  const peoplePages = ['employees', 'types', 'plans'] as const;
  /** Incentive to load when an import is opened from the register. */
  const [openSetId, setOpenSetId] = useState<string | null>(null);
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
        <div className="space-y-1 border-t border-slate-200 p-2">
          <button
            onClick={() => setPage('incentives')}
            className={`block w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-slate-100 ${page === 'incentives' ? 'bg-indigo-50 text-indigo-700' : 'text-slate-700'}`}
          >
            <div className="font-medium">Incentives</div>
            <div className="text-xs text-slate-400">saved filters, summaries, calculations</div>
          </button>
          {/* Employees group: hover (or an active sub-page) reveals one level deeper. */}
          <div onMouseEnter={() => setPeopleOpen(true)} onMouseLeave={() => setPeopleOpen(false)}>
            <button
              onClick={() => setPage('employees')}
              className={`flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm hover:bg-slate-100 ${page === 'employees' ? 'bg-indigo-50 text-indigo-700' : 'text-slate-700'}`}
            >
              <div className="flex-1">
                <div className="font-medium">Employees</div>
                <div className="text-xs text-slate-400">people, salary, bonuses</div>
              </div>
              <span className={`text-slate-400 transition-transform ${peopleOpen || peoplePages.includes(page as (typeof peoplePages)[number]) ? 'rotate-90' : ''}`}>▸</span>
            </button>
            {(peopleOpen || peoplePages.includes(page as (typeof peoplePages)[number])) && (
              <div className="ml-3 border-l border-slate-200 pl-2">
                <button
                  onClick={() => setPage('types')}
                  className={`block w-full rounded-md px-2 py-1 text-left text-sm hover:bg-slate-100 ${page === 'types' ? 'bg-indigo-50 text-indigo-700' : 'text-slate-700'}`}
                >
                  <div className="font-medium">Employee types</div>
                  <div className="text-xs text-slate-400">roles with default plans</div>
                </button>
                <button
                  onClick={() => setPage('plans')}
                  className={`block w-full rounded-md px-2 py-1 text-left text-sm hover:bg-slate-100 ${page === 'plans' ? 'bg-indigo-50 text-indigo-700' : 'text-slate-700'}`}
                >
                  <div className="font-medium">Comp plans</div>
                  <div className="text-xs text-slate-400">rates, quotas, tiers</div>
                </button>
              </div>
            )}
          </div>
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
        ) : page === 'employees' ? (
          <EmployeesView />
        ) : page === 'types' ? (
          <EmployeeTypesView />
        ) : page === 'incentives' ? (
          <IncentivesView
            onOpen={(importId, setId) => {
              setOpenSetId(setId);
              setSelected(importId);
              setUploading(false);
              setPage('imports');
            }}
          />
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
            key={`${selected}:${openSetId ?? ''}`}
            importId={selected}
            initialSetId={openSetId}
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
