import type { FeatureKey } from '@commissions/shared';
import { useMemo, useState } from 'react';
import { AccountingSettingsView } from './components/accounting/AccountingSettingsView';
import { AmortizationRegisterView } from './components/accounting/AmortizationRegisterView';
import { RollForwardReportView, WaterfallReportView } from './components/accounting/AmortizationReportsView';
import { AmortizationMethodsView } from './components/accounting/AmortizationMethodsView';
import { AmortizationTypesView } from './components/accounting/AmortizationTypesView';
import { JournalsView, ReclassView } from './components/accounting/JournalsView';
import { MonthlyCloseView } from './components/accounting/MonthlyCloseView';
import { CommissionsView, type PayrollNav } from './components/CommissionsView';
import { ComingSoon } from './components/ComingSoon';
import { DashboardView } from './components/DashboardView';
import { EmployeeTypesView } from './components/EmployeeTypesView';
import { EmployeesView } from './components/EmployeesView';
import { ProgramsView } from './components/ProgramsView';
import { PayoutRulesView } from './components/PayoutRulesView';
import { SettingsView } from './components/SettingsView';
import { useSettings } from './components/SettingsProvider';
import { SetupView, UpgradeNotice, type SetupTarget } from './components/setup/SetupView';
import { useAuth } from './components/AuthGate';

/** The existing screens a sidebar item can open. 'soon' = a page that isn't built yet. */
type Screen =
  | 'dashboard'
  | 'runs'
  | 'incentives'
  | 'employees'
  | 'types'
  | 'plans'
  | 'payoutrules'
  | 'acctpolicy'
  | 'amorttypes'
  | 'amortmethods'
  | 'register'
  | 'rollforward'
  | 'waterfall'
  | 'close'
  | 'journals'
  | 'reclass'
  | 'users'
  | 'setup'
  | 'soon';

type NavItem = { key: string; label: string; screen: Screen; children?: NavItem[] };
type NavSection = { key: string; label: string; items: NavItem[] };

const PINNED: NavItem[] = [{ key: 'overview', label: 'Overview', screen: 'dashboard' }];

/** Sidebar layout, designed in Sidebar Studio (Oct 2026). */
const SECTIONS: NavSection[] = [
  {
    key: 'plans',
    label: 'Comp Plans',
    items: [
      { key: 'plans-rates-quotas', label: 'Plans, rates and quotas', screen: 'plans' },
      { key: 'spiffs-accelerators-bonus', label: 'Spiffs, Accelerators, and Bonus Plans', screen: 'incentives' },
      { key: 'mid-year-recasts', label: 'Mid-year recasts', screen: 'soon' },
      { key: 'clawbacks', label: 'Clawbacks', screen: 'soon' },
    ],
  },
  {
    key: 'payouts',
    label: 'Payouts',
    items: [
      { key: 'payout-rules', label: 'Payout Rules', screen: 'payoutrules' },
      { key: 'payouts-on-hold', label: 'Payouts On Hold', screen: 'runs' },
      { key: 'commission-payroll', label: 'Commission Payroll', screen: 'runs' },
    ],
  },
  {
    key: 'accounting',
    label: 'Accounting',
    items: [
      { key: 'accounting-settings', label: 'Accounting Settings', screen: 'acctpolicy' },
      { key: 'amortization-types', label: 'Amortization Types', screen: 'amorttypes' },
      { key: 'amortization-methods', label: 'Amortization Methods', screen: 'amortmethods' },
      {
        key: 'amortization-registers',
        label: 'Amortization Register',
        screen: 'register',
        children: [
          { key: 'amortization-rollforward', label: 'Roll Forward', screen: 'rollforward' },
          { key: 'amortization-waterfall', label: 'Waterfall', screen: 'waterfall' },
        ],
      },
      {
        key: 'process-monthly-accounting',
        label: 'Process Monthly Accounting',
        screen: 'close',
        children: [
          { key: 'monthly-journals', label: 'Monthly Journals', screen: 'journals' },
          { key: 'monthly-reclass', label: 'Monthly Reclass', screen: 'reclass' },
        ],
      },
    ],
  },
  {
    key: 'reports',
    label: 'Statements & Reports',
    items: [
      { key: 'reporting', label: 'Reporting', screen: 'soon' },
      { key: 'employee-statements', label: 'Employee Statements', screen: 'soon' },
      { key: 'annual-plan-design', label: 'Annual Plan Design', screen: 'soon' },
    ],
  },
  {
    key: 'employees',
    label: 'Employees',
    items: [
      { key: 'employees', label: 'Employees', screen: 'employees' },
      { key: 'employee-types', label: 'Employee types', screen: 'types' },
      { key: 'users', label: 'Users', screen: 'users' },
    ],
  },
  {
    key: 'setup',
    label: 'Setup',
    items: [{ key: 'global-settings', label: 'Global Settings', screen: 'setup' }],
  },
];

/** Sidebar items a system feature (Setup › System Features) can hide. */
const FEATURE_OF: Record<string, FeatureKey> = {
  'spiffs-accelerators-bonus': 'incentives',
  'mid-year-recasts': 'recasts',
  clawbacks: 'clawbacks',
  'payout-rules': 'holds',
  'payouts-on-hold': 'holds',
  'accounting-settings': 'accounting',
  'amortization-types': 'accounting',
  'amortization-methods': 'accounting',
  'amortization-registers': 'accounting',
  'process-monthly-accounting': 'accounting',
  reporting: 'reporting',
  'employee-statements': 'statements',
  'annual-plan-design': 'planDesign',
};

type Page = { key: string; assetId?: string | null; payroll?: PayrollNav };

/** key -> item, its section label, and its parent (for sub-pages). */
function indexNav() {
  const map = new Map<string, { item: NavItem; section: string; parent?: NavItem }>();
  const add = (items: NavItem[], section: string, parent?: NavItem) =>
    items.forEach((item) => {
      map.set(item.key, { item, section, parent });
      if (item.children) add(item.children, section, item);
    });
  add(PINNED, '');
  SECTIONS.forEach((s) => add(s.items, s.label));
  return map;
}

const contains = (item: NavItem, key: string): boolean => item.key === key || (item.children ?? []).some((c) => contains(c, key));

export default function App() {
  const { user, signOut } = useAuth();
  const { feature } = useSettings();
  const nav = useMemo(indexNav, []);
  // Switched-off features drop out of the sidebar; a section with nothing left disappears.
  const sections = useMemo(
    () => SECTIONS.map((s) => ({ ...s, items: s.items.filter((it) => !FEATURE_OF[it.key] || feature(FEATURE_OF[it.key])) })).filter((s) => s.items.length > 0),
    [feature],
  );
  const [page, setPage] = useState<Page>({ key: 'overview' });
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const go = (key: string) => setPage({ key });
  const openAsset = (assetId: string) => setPage({ key: 'amortization-registers', assetId });
  // Imports live on the Commission Payroll screen.
  const openPayroll = (payroll: PayrollNav) => setPage({ key: 'commission-payroll', payroll });
  const openImport = (importId: string | null, setId: string | null = null) => openPayroll({ tab: 'imports', importId, setId });
  const openSetupTarget = (t: SetupTarget) => {
    if (t === 'upload') return openPayroll({ tab: 'imports', uploading: true });
    if (t === 'imports') return openPayroll({ tab: 'imports' });
    if (t === 'templates') return openPayroll({ tab: 'templates' });
    const key: Record<Exclude<SetupTarget, 'upload' | 'imports' | 'templates'>, string> = { employees: 'employees', types: 'employee-types', users: 'users', plans: 'plans-rates-quotas', holdreasons: 'payout-rules', acctpolicy: 'accounting-settings' };
    go(key[t]);
  };

  const entry = nav.get(page.key) ?? nav.get('overview')!;
  const screen = entry.item.screen;

  const renderItem = (it: NavItem, depth: number) => {
    const active = page.key === it.key;
    const hasKids = !!it.children?.length;
    const open = hasKids && !collapsed[it.key];
    return (
      <div key={it.key}>
        <button
          className={`nav-item ${depth ? 'py-1 text-[13px]' : ''} ${active ? 'nav-item-active' : ''}`}
          onClick={() => go(it.key)}
          title={it.label}
        >
          <span className="flex-1 truncate">{it.label}</span>
          {it.screen === 'soon' && <span className="nav-soon">soon</span>}
          {hasKids && (
            <span
              role="button"
              aria-label={open ? 'Close sub-pages' : 'Open sub-pages'}
              className={`inline-block w-4 text-center text-slate-400 transition-transform ${open ? 'rotate-90' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                setCollapsed((c) => ({ ...c, [it.key]: !c[it.key] }));
              }}
            >
              ›
            </span>
          )}
        </button>
        {open && <div className="nav-sub mt-0.5 space-y-0.5">{it.children!.map((c) => renderItem(c, depth + 1))}</div>}
      </div>
    );
  };

  const renderScreen = () => {
    switch (screen) {
      case 'dashboard':
        return (
          <DashboardView
            onOpenRuns={() => openPayroll({ tab: 'runs' })}
            onOpenImport={(id) => openImport(id)}
            onOpenIncentive={(importId, setId) => openImport(importId, setId)}
          />
        );
      case 'runs':
        return <CommissionsView key={page.key} nav={page.payroll ?? {}} onNavigate={(n) => setPage({ key: page.key, payroll: n })} />;
      case 'incentives':
        return <ProgramsView />;
      case 'employees':
        return <EmployeesView />;
      case 'types':
        return <EmployeeTypesView />;
      case 'plans':
        return <SettingsView tab="plans" />;
      case 'payoutrules':
        return <PayoutRulesView />;
      case 'acctpolicy':
        return <AccountingSettingsView onOpenMethods={() => go('amortization-methods')} />;
      case 'amorttypes':
        return <AmortizationTypesView />;
      case 'amortmethods':
        return <AmortizationMethodsView />;
      case 'register':
        return (
          <AmortizationRegisterView
            onOpenClose={() => go('process-monthly-accounting')}
            openId={page.assetId ?? null}
            onOpenId={(assetId) => setPage({ key: 'amortization-registers', assetId })}
          />
        );
      case 'rollforward':
        return <RollForwardReportView onOpenAsset={openAsset} />;
      case 'waterfall':
        return <WaterfallReportView onOpenAsset={openAsset} />;
      case 'close':
        return <MonthlyCloseView onOpenTypes={() => go('amortization-types')} onOpenRegister={() => go('amortization-registers')} />;
      case 'journals':
        return <JournalsView />;
      case 'reclass':
        return <ReclassView />;
      case 'users':
        return <SettingsView tab="users" />;
      case 'setup':
        return <SetupView onNavigate={openSetupTarget} />;
      case 'soon':
        return <ComingSoon key={entry.item.key} title={entry.item.label} section={[entry.section, entry.parent?.label].filter(Boolean).join(' › ')} />;
    }
  };

  return (
    <div className="flex h-full">
      <aside className="flex w-60 shrink-0 flex-col border-r border-slate-200 bg-panel">
        <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3">
          <span className="inline-block h-6 w-6 rounded-md bg-brand" aria-hidden />
          <div>
            <div className="text-sm font-semibold tracking-tight">Sweyt Incentive</div>
            <div className="text-[11px] text-slate-400">commissions & incentives</div>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto px-2 pb-3">
          <div className="space-y-0.5 pt-2">{PINNED.map((it) => renderItem(it, 0))}</div>
          {sections.map((s) => {
            const open = !collapsed[s.key];
            const sectionActive = s.items.some((i) => contains(i, page.key));
            return (
              <div key={s.key}>
                <button
                  className={`nav-section flex w-full items-center gap-1 ${sectionActive ? 'nav-section-active' : ''}`}
                  aria-expanded={open}
                  onClick={() => setCollapsed((c) => ({ ...c, [s.key]: !c[s.key] }))}
                >
                  <span className={`inline-block transition-transform ${open ? 'rotate-90' : ''}`}>▸</span>
                  {s.label}
                </button>
                {open && <div className="space-y-0.5">{s.items.map((it) => renderItem(it, 0))}</div>}
              </div>
            );
          })}
        </nav>

        <div className="flex items-center gap-2 border-t border-slate-200 px-3 py-2 text-xs">
          <span className="nav-avatar flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold" aria-hidden>
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
        <UpgradeNotice />
        {renderScreen()}
      </main>
    </div>
  );
}
