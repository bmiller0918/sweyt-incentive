import { useCallback, useEffect, useState } from 'react';
import { api, type ImportSummary } from './api';
import { CommissionsView } from './components/CommissionsView';
import { DashboardView } from './components/DashboardView';
import { EmployeeTypesView } from './components/EmployeeTypesView';
import { EmployeesView } from './components/EmployeesView';
import { ImportView } from './components/ImportView';
import { IncentivesView } from './components/IncentivesView';
import { SettingsView } from './components/SettingsView';
import { UploadFlow } from './components/UploadFlow';
import { useAuth } from './components/AuthGate';

type Page =
  | { kind: 'dashboard' }
  | { kind: 'imports'; importId: string | null; setId?: string | null; uploading?: boolean }
  | { kind: 'incentives' }
  | { kind: 'employees' }
  | { kind: 'types' }
  | { kind: 'commissions' }
  | { kind: 'settings'; tab: 'plans' | 'hold-reasons' | 'accounting' | 'users' };

/** Sidebar sections: top-level areas, each with its sub-pages. */
const SECTIONS: { key: string; label: string; items: { label: string; hint: string; page: Page; match: (p: Page) => boolean }[] }[] = [
  {
    key: 'dashboards',
    label: 'Dashboards',
    items: [{ label: 'Overview', hint: 'what’s loaded, latest runs', page: { kind: 'dashboard' }, match: (p) => p.kind === 'dashboard' }],
  },
  {
    key: 'data',
    label: 'Data',
    items: [
      { label: 'Imports', hint: 'spreadsheets and links', page: { kind: 'imports', importId: null }, match: (p) => p.kind === 'imports' },
      { label: 'Incentives', hint: 'saved filters, summaries, calculations', page: { kind: 'incentives' }, match: (p) => p.kind === 'incentives' },
    ],
  },
  {
    key: 'employees',
    label: 'Employees',
    items: [
      { label: 'Employees', hint: 'people, salary, bonuses', page: { kind: 'employees' }, match: (p) => p.kind === 'employees' },
      { label: 'Employee types', hint: 'roles with default plans', page: { kind: 'types' }, match: (p) => p.kind === 'types' },
    ],
  },
  {
    key: 'commissions',
    label: 'Commissions',
    items: [{ label: 'Runs', hint: 'one line per person per deal', page: { kind: 'commissions' }, match: (p) => p.kind === 'commissions' }],
  },
  {
    key: 'settings',
    label: 'Settings',
    items: [
      { label: 'Comp plans', hint: 'rates, quotas, tiers', page: { kind: 'settings', tab: 'plans' }, match: (p) => p.kind === 'settings' && p.tab === 'plans' },
      { label: 'Hold reasons', hint: 'why a line waits', page: { kind: 'settings', tab: 'hold-reasons' }, match: (p) => p.kind === 'settings' && p.tab === 'hold-reasons' },
      { label: 'Accounting policy', hint: 'amortization method', page: { kind: 'settings', tab: 'accounting' }, match: (p) => p.kind === 'settings' && p.tab === 'accounting' },
      { label: 'Users', hint: 'who can sign in', page: { kind: 'settings', tab: 'users' }, match: (p) => p.kind === 'settings' && p.tab === 'users' },
    ],
  },
];

export default function App() {
  const { user, signOut } = useAuth();
  const [imports, setImports] = useState<ImportSummary[]>([]);
  const [page, setPage] = useState<Page>({ kind: 'dashboard' });
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
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
    refresh();
  }, [refresh]);

  const openImport = (importId: string | null, setId: string | null = null) => setPage({ kind: 'imports', importId, setId });
  const openUpload = () => setPage({ kind: 'imports', importId: null, uploading: true });

  // "Imports" with nothing selected shows the first import, or the upload screen.
  const importsPage = page.kind === 'imports' ? page : null;
  const selectedImport = importsPage && !importsPage.uploading ? (importsPage.importId ?? imports[0]?.id ?? null) : null;

  return (
    <div className="flex h-full">
      <aside className="flex w-60 shrink-0 flex-col border-r border-slate-200 bg-panel">
        <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3">
          <span className="inline-block h-6 w-6 rounded-md bg-indigo-600" aria-hidden />
          <div>
            <div className="text-sm font-semibold tracking-tight">Sweyt Incentive</div>
            <div className="text-[11px] text-slate-400">commissions & incentives</div>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto px-2 pb-3">
          {SECTIONS.map((s) => {
            const open = !collapsed[s.key];
            const sectionActive = s.items.some((i) => i.match(page));
            return (
              <div key={s.key}>
                <button
                  className={`nav-section flex w-full items-center gap-1 ${sectionActive ? 'text-indigo-700' : ''}`}
                  onClick={() => setCollapsed((c) => ({ ...c, [s.key]: !c[s.key] }))}
                >
                  <span className={`inline-block transition-transform ${open ? 'rotate-90' : ''}`}>▸</span>
                  {s.label}
                </button>
                {open && (
                  <div className="space-y-0.5">
                    {s.items.map((it) => (
                      <div key={it.label}>
                        <button className={`nav-item ${it.match(page) ? 'nav-item-active' : ''}`} onClick={() => setPage(it.page)} title={it.hint}>
                          <span className="flex-1 truncate">{it.label}</span>
                        </button>
                        {/* Imports: the list of spreadsheets lives one level deeper. */}
                        {it.label === 'Imports' && (
                          <div className="nav-sub mt-0.5 space-y-0.5">
                            {imports.map((imp) => (
                              <button
                                key={imp.id}
                                onClick={() => openImport(imp.id)}
                                className={`nav-item py-1 text-xs ${page.kind === 'imports' && !page.uploading && selectedImport === imp.id ? 'nav-item-active' : ''}`}
                                title={`${imp.rowCount.toLocaleString()} rows · ${new Date(imp.createdAt).toLocaleDateString()}`}
                              >
                                <span className="truncate">{imp.name}</span>
                              </button>
                            ))}
                            <button className={`nav-item py-1 text-xs text-indigo-700 ${page.kind === 'imports' && page.uploading ? 'nav-item-active' : ''}`} onClick={openUpload}>
                              + New import
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        <div className="flex items-center gap-2 border-t border-slate-200 px-3 py-2 text-xs">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-indigo-100 text-[11px] font-semibold text-indigo-800" aria-hidden>
            {user.name
              .split(/\s+/)
              .map((w) => w[0])
              .join('')
              .slice(0, 2)
              .toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium text-slate-700">{user.name}</div>
            <div className="truncate text-[11px] text-slate-400">{user.email}</div>
          </div>
          <button className="text-slate-400 hover:text-slate-700" onClick={signOut} title="Sign out">
            Sign out
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
        {page.kind === 'dashboard' ? (
          <DashboardView onOpenRuns={() => setPage({ kind: 'commissions' })} onOpenImport={(id) => openImport(id)} onOpenIncentive={(importId, setId) => openImport(importId, setId)} />
        ) : page.kind === 'commissions' ? (
          <CommissionsView />
        ) : page.kind === 'settings' ? (
          <SettingsView tab={page.tab} />
        ) : page.kind === 'employees' ? (
          <EmployeesView />
        ) : page.kind === 'types' ? (
          <EmployeeTypesView />
        ) : page.kind === 'incentives' ? (
          <IncentivesView onOpen={(importId, setId) => openImport(importId, setId)} />
        ) : page.uploading || !selectedImport ? (
          <UploadFlow
            onDone={async (imp) => {
              await refresh();
              openImport(imp.id);
            }}
            onCancel={imports.length ? () => openImport(imports[0].id) : undefined}
          />
        ) : (
          <ImportView
            key={`${selectedImport}:${page.setId ?? ''}`}
            importId={selectedImport}
            initialSetId={page.setId ?? null}
            onDeleted={async () => {
              const list = await refresh();
              if (list.length) openImport(list[0].id);
              else openUpload();
            }}
            onRenamed={refresh}
          />
        )}
      </main>
    </div>
  );
}
