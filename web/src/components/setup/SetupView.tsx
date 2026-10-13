// Setup › Global Settings: General, System Features, Import Tools, Licensing,
// Manage Upgrades. The layout follows NetAsset's setup page; the contents are
// what applies to a commissions tool.
import {
  FEATURES,
  PERMISSIONS,
  QUICK_ACTIONS,
  UPGRADE_PREFERENCES,
  UPGRADE_PREFERENCE_LABELS,
  formatRecordNumber,
  type AppSettings,
  type PermissionLevel,
} from '@commissions/shared';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, type SetupUsage, type SystemInfo } from '../../api';
import { ErrorBar, Field, PageHeader } from '../accounting/ui';
import { useAuth } from '../AuthGate';
import { useSettings } from '../SettingsProvider';

export type SetupTarget = 'upload' | 'imports' | 'employees' | 'types' | 'users' | 'plans' | 'holdreasons' | 'acctpolicy';

const TABS = ['General', 'System Features', 'Import Tools', 'Licensing', 'Manage Upgrades'] as const;
type Tab = (typeof TABS)[number];

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const fmtDateTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '—');
const fmtDate = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString() : '—');

export function SetupView({ onNavigate }: { onNavigate: (target: SetupTarget) => void }) {
  const { user } = useAuth();
  const { settings, refresh } = useSettings();
  const admin = user.role === 'admin';
  const [tab, setTab] = useState<Tab>('General');
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<SetupUsage | null>(null);
  const [system, setSystem] = useState<SystemInfo | null>(null);

  useEffect(() => setDraft(settings), [settings]);
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(settings), [draft, settings]);

  const loadUsage = () => api.getSetupUsage().then(setUsage).catch((e) => setError(e.message));
  useEffect(() => {
    loadUsage();
    api.getSystemInfo().then(setSystem).catch((e) => setError(e.message));
  }, []);

  const save = async () => {
    setError(null);
    try {
      await api.updateSettings(draft);
      await refresh();
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const set = <K extends keyof AppSettings>(section: K, patch: Partial<AppSettings[K]>) => setDraft({ ...draft, [section]: { ...draft[section], ...patch } });

  return (
    <div className="flex h-full flex-col overflow-auto">
      <PageHeader
        section="Setup"
        title="Global Settings"
        hint={
          admin
            ? 'Usually set once during implementation and revisited when a new feature is switched on. Changes apply to everyone as soon as they are saved.'
            : 'Read-only: only admins can change global settings.'
        }
      >
        {saved && <span className="text-xs text-emerald-700">Saved</span>}
        {tab === 'Licensing' && (
          <button className="btn btn-sm" onClick={loadUsage}>
            Sync usage
          </button>
        )}
        <button className="btn btn-sm" disabled={!dirty} onClick={() => setDraft(settings)}>
          Cancel
        </button>
        <button className="btn btn-sm btn-primary" disabled={!admin || !dirty} onClick={save}>
          Save
        </button>
      </PageHeader>
      <ErrorBar error={error} onDismiss={() => setError(null)} />

      <div className="flex gap-1 border-b border-slate-200 px-6 text-sm">
        {TABS.map((t) => (
          <button key={t} className={`-mb-px border-b-2 px-3 py-2 ${tab === t ? 'border-indigo-600 font-semibold text-slate-900' : 'border-transparent text-slate-500 hover:text-slate-800'}`} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>

      <div className="mx-auto w-full max-w-6xl p-6">
        {tab === 'Import Tools' && (
          <div className="space-y-4">
            <ImportToolsTab onNavigate={onNavigate} onPermissions={() => setTab('System Features')} />
          </div>
        )}
        {tab === 'Licensing' && (
          <div className="space-y-4">
            <LicensingTab usage={usage} />
          </div>
        )}
        {(tab === 'General' || tab === 'System Features' || tab === 'Manage Upgrades') && (
          // Inputs are read-only for non-admins; the section toggles are divs so they keep working.
          <fieldset disabled={!admin} className="space-y-4">
            {tab === 'General' && <GeneralTab draft={draft} set={set} />}
            {tab === 'System Features' && <FeaturesTab draft={draft} set={set} />}
            {tab === 'Manage Upgrades' && <UpgradesTab draft={draft} set={set} system={system} />}
          </fieldset>
        )}
      </div>
    </div>
  );
}

type SetFn = <K extends keyof AppSettings>(section: K, patch: Partial<AppSettings[K]>) => void;

// -- General ----------------------------------------------------------------------

function GeneralTab({ draft, set }: { draft: AppSettings; set: SetFn }) {
  const g = draft.general;
  const setG = (patch: Partial<AppSettings['general']>) => set('general', patch);
  return (
    <>
      <Section title="Transition Selections">
        <div className="grid gap-4 md:grid-cols-3">
          <Labelled label="Go-live date" required hint="When commission balances are established and the GL is first impacted. No month before it can be closed, and new commission runs default to deals closed on or after it. Earlier commissions come in as opening balances in the amortization register.">
            <input type="date" className="input mt-1 block w-44" value={g.goLiveDate ?? ''} onChange={(e) => setG({ goLiveDate: e.target.value || null })} />
          </Labelled>
        </div>
      </Section>

      <Section title="Calendar">
        <div className="grid gap-4 md:grid-cols-3">
          <Labelled label="Fiscal year starts in" hint="Drives the fiscal-quarter and fiscal-year presets in period filters, hold rules and plan effective periods.">
            <select className="select mt-1 block w-44" value={g.fiscalYearStartMonth} onChange={(e) => setG({ fiscalYearStartMonth: Number(e.target.value) })}>
              {MONTHS.map((m, i) => (
                <option key={m} value={i + 1}>
                  {m}
                </option>
              ))}
            </select>
          </Labelled>
          <Labelled label="Week starts on" hint="For the this-week and last-week presets.">
            <select className="select mt-1 block w-44" value={g.weekStartsOn} onChange={(e) => setG({ weekStartsOn: Number(e.target.value) === 0 ? 0 : 1 })}>
              <option value={1}>Monday</option>
              <option value={0}>Sunday</option>
            </select>
          </Labelled>
        </div>
      </Section>

      <Section title="Commission Run Settings">
        <div className="grid gap-4 md:grid-cols-3">
          <Labelled label="Default pay lag (months)" hint="Months between a deal’s close (or a release from hold) and the payroll it pays on. 1 = the month after the close. Each run can override it.">
            <input type="number" min={0} max={12} className="input mt-1 block w-24" value={g.defaultPayLagMonths} onChange={(e) => setG({ defaultPayLagMonths: Math.max(0, Math.min(12, Number(e.target.value) || 0)) })} />
          </Labelled>
          <Check
            label="Allow direct input of amortization records"
            hint="Let users enter amortizations by hand in the register (opening balances, adjustments) instead of only through the monthly close."
            checked={g.allowManualAmortizations}
            onChange={(v) => setG({ allowManualAmortizations: v })}
          />
          <div className="space-y-3">
            <Labelled label="Auto-numbering prefix" hint="Prefix for amortization record ids.">
              <input className="input mt-1 block w-32 font-mono" value={g.amortizationPrefix} onChange={(e) => setG({ amortizationPrefix: e.target.value })} />
            </Labelled>
            <Labelled label="Auto-numbering minimum digits" hint={`Ids look like ${formatRecordNumber(1, g.amortizationPrefix || 'AMRT', g.amortizationMinDigits)}; longer numbers are never cut.`}>
              <input type="number" min={1} max={10} className="input mt-1 block w-24" value={g.amortizationMinDigits} onChange={(e) => setG({ amortizationMinDigits: Math.max(1, Math.min(10, Number(e.target.value) || 1)) })} />
            </Labelled>
          </div>
        </div>
      </Section>

      <Section title="Period Controls">
        <div className="grid gap-4 md:grid-cols-3">
          <Check
            label="Allow releases that pay in a closed month"
            hint="A release is dated, and pays on the payroll after that date. Off: a release whose pay month is already closed is refused, so the books stay as closed."
            checked={g.allowReleaseIntoClosedMonth}
            onChange={(v) => setG({ allowReleaseIntoClosedMonth: v })}
          />
          <Check
            label="Allow reopening the latest closed month"
            hint="Off is a journal deletion control: once a month is closed, nothing it booked can be reversed from the app."
            checked={g.allowReopenClosedMonth}
            onChange={(v) => setG({ allowReopenClosedMonth: v })}
          />
        </div>
      </Section>
    </>
  );
}

// -- System Features ------------------------------------------------------------------

function FeaturesTab({ draft, set }: { draft: AppSettings; set: SetFn }) {
  return (
    <>
      <Section title="Enable System Features" hint="Switch off what the business doesn’t use; the sidebar and the pages hide it.">
        <div className="grid gap-x-6 gap-y-3 md:grid-cols-3">
          {FEATURES.map((f) => (
            <Check key={f.key} label={f.label} hint={f.hint} soon={f.planned} checked={draft.features[f.key]} onChange={(v) => set('features', { [f.key]: v })} />
          ))}
        </div>
      </Section>

      <Section title="Quick Access Buttons" hint="Buttons on a commission run. Switching one off removes the shortcut; the API and the audit log are unchanged.">
        <div className="grid gap-x-6 gap-y-3 md:grid-cols-3">
          {QUICK_ACTIONS.map((q) => (
            <Check key={q.key} label={q.label} hint={q.hint} checked={draft.quickActions[q.key]} onChange={(v) => set('quickActions', { [q.key]: v })} />
          ))}
        </div>
      </Section>

      <Section title="Restrict Feature Permissions" hint="Who can perform each action. Reading is open to everyone signed in; admins can always do everything.">
        <table className="w-full text-xs">
          <thead className="text-left text-slate-400">
            <tr className="border-b border-slate-200">
              <th className="py-1.5 pr-3 font-normal">Feature</th>
              <th className="py-1.5 pr-3 font-normal">Covers</th>
              <th className="py-1.5 font-normal">Who</th>
            </tr>
          </thead>
          <tbody>
            {PERMISSIONS.map((p) => (
              <tr key={p.key} className="border-b border-slate-100">
                <td className="py-1.5 pr-3 font-medium whitespace-nowrap">{p.label}</td>
                <td className="py-1.5 pr-3 text-slate-500">{p.hint}</td>
                <td className="py-1.5">
                  <select className="select" value={draft.permissions[p.key]} onChange={(e) => set('permissions', { [p.key]: e.target.value as PermissionLevel })}>
                    <option value="all">All users</option>
                    <option value="admin">Admins only</option>
                  </select>
                </td>
              </tr>
            ))}
            <tr className="border-b border-slate-100 text-slate-400">
              <td className="py-1.5 pr-3 whitespace-nowrap">Manage users</td>
              <td className="py-1.5 pr-3">Add and remove sign-in accounts.</td>
              <td className="py-1.5">Admins only (always)</td>
            </tr>
            <tr className="text-slate-400">
              <td className="py-1.5 pr-3 whitespace-nowrap">Global settings</td>
              <td className="py-1.5 pr-3">This page.</td>
              <td className="py-1.5">Admins only (always)</td>
            </tr>
          </tbody>
        </table>
      </Section>
    </>
  );
}

// -- Import Tools --------------------------------------------------------------------------

function ImportToolsTab({ onNavigate, onPermissions }: { onNavigate: (t: SetupTarget) => void; onPermissions: () => void }) {
  return (
    <>
      <Section title="Deals">
        <div className="grid gap-4 md:grid-cols-2">
          <Tool label="Deals CSV import template" hint="One row per deal: id, rep and other payees, amount, close date, subscription start and term, and columns for hold rules.">
            <a className="text-indigo-600 hover:underline" href={api.templateUrl('deals')} download>
              Download link
            </a>
          </Tool>
          <Tool label="Data import wizard" hint="Drag in a CSV or Excel file, pick the sheet and header row, confirm column types.">
            <ToolLink onClick={() => onNavigate('upload')} />
          </Tool>
        </div>
      </Section>
      <Section title="Linked Imports">
        <div className="grid gap-4 md:grid-cols-2">
          <Tool label="Payments (child) CSV import template" hint="Rows keyed to a deal, to link as a child of the deals import for roll-ups like Sum of Amount.">
            <a className="text-indigo-600 hover:underline" href={api.templateUrl('payments')} download>
              Download link
            </a>
          </Tool>
          <Tool label="Link imports" hint="Open an import and press Links to make it a child of another on a key column.">
            <ToolLink onClick={() => onNavigate('imports')} />
          </Tool>
        </div>
      </Section>
      <Section title="Employees">
        <div className="grid gap-4 md:grid-cols-2">
          <Tool label="Add employees from an import" hint="Tick names from a column of an import to create employees in bulk, optionally with a type.">
            <ToolLink onClick={() => onNavigate('employees')} />
          </Tool>
          <Tool label="Employee types" hint="Roles with default plan assignments, base salary and quota; most setup happens here once.">
            <ToolLink onClick={() => onNavigate('types')} />
          </Tool>
        </div>
      </Section>
      <Section title="Permissions">
        <div className="grid gap-4 md:grid-cols-2">
          <Tool label="Users" hint="Sign-in accounts and their role (admin or member).">
            <ToolLink onClick={() => onNavigate('users')} />
          </Tool>
          <Tool label="Restrict feature permissions" hint="Which actions are limited to admins.">
            <ToolLink onClick={onPermissions} />
          </Tool>
        </div>
      </Section>
    </>
  );
}

// -- Licensing -----------------------------------------------------------------------------

function LicensingTab({ usage }: { usage: SetupUsage | null }) {
  if (!usage) return <div className="text-sm text-slate-400">Loading…</div>;
  const { license, usage: u } = usage;
  return (
    <>
      <Section title="License Info">
        <div className="grid gap-4 md:grid-cols-4">
          <Field label="Edition">{license.edition}</Field>
          <Field label="License status">
            <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[11px] text-emerald-700">{license.status}</span>
          </Field>
          <Field label="Date last synced">{fmtDateTime(license.syncedAt)}</Field>
        </div>
      </Section>
      <Section title="Usage Info" hint="What a seat-based tier would count is active employees; everything else is for a sense of scale.">
        <div className="grid gap-4 md:grid-cols-4">
          <div className="space-y-4">
            <Field label="Tier max">{license.tierMax === null ? '- No limit in a self-hosted workspace -' : license.tierMax.toLocaleString()}</Field>
            <Field label="Employees towards tier max">{license.countsTowardTier.toLocaleString()}</Field>
          </div>
          <div className="space-y-4">
            <Field label="Active employees">{u.employees.active.toLocaleString()}</Field>
            <Field label="On leave">{u.employees.leave.toLocaleString()}</Field>
            <Field label="Terminated">{u.employees.terminated.toLocaleString()}</Field>
            <Field label="Inactive">{u.employees.inactive.toLocaleString()}</Field>
          </div>
          <div className="space-y-4">
            <Field label="Users">{u.users.toLocaleString()}</Field>
            <Field label="Imports">{`${u.imports.count.toLocaleString()} · ${u.imports.rows.toLocaleString()} rows`}</Field>
            <Field label="Comp plans">{u.compPlans.toLocaleString()}</Field>
            <Field label="Employee types">{u.employeeTypes.toLocaleString()}</Field>
            <Field label="Saved incentives">{u.incentives.toLocaleString()}</Field>
          </div>
          <div className="space-y-4">
            <Field label="Commission runs">{u.runs.toLocaleString()}</Field>
            <Field label="Lines paying next payroll">{u.lines.pay.toLocaleString()}</Field>
            <Field label="Lines on hold">{u.lines.hold.toLocaleString()}</Field>
            <Field label="Lines released">{u.lines.released.toLocaleString()}</Field>
            <Field label="Amortization records">{`${u.amortizations.total.toLocaleString()} · ${u.amortizations.manual.toLocaleString()} by hand`}</Field>
            <Field label="Closed months">{u.closedMonths.count ? `${u.closedMonths.count} · latest ${u.closedMonths.latest}` : '0'}</Field>
          </div>
        </div>
      </Section>
    </>
  );
}

// -- Manage Upgrades ---------------------------------------------------------------------------

function UpgradesTab({ draft, set, system }: { draft: AppSettings; set: SetFn; system: SystemInfo | null }) {
  const u = draft.upgrades;
  const setU = (patch: Partial<AppSettings['upgrades']>) => set('upgrades', patch);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const addRecipient = () => {
    if (!name.trim() || !email.trim()) return;
    setU({ releaseNotesRecipients: [...u.releaseNotesRecipients, { name: name.trim(), email: email.trim() }] });
    setName('');
    setEmail('');
  };
  return (
    <>
      <Section title="Upgrade Preference">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-4">
            <Labelled label="Upgrade preference" required hint="The cadence your team has agreed for taking releases. The service itself deploys from the Railway pipeline; this records the policy and drives the next-upgrade date.">
              <select className="select mt-1 block w-72" value={u.preference} onChange={(e) => setU({ preference: e.target.value as AppSettings['upgrades']['preference'] })}>
                {UPGRADE_PREFERENCES.map((p) => (
                  <option key={p} value={p}>
                    {UPGRADE_PREFERENCE_LABELS[p]}
                  </option>
                ))}
              </select>
            </Labelled>
            <Labelled label="Next upgrade date" hint={u.preference === 'custom' ? 'When the next release is planned to go in.' : 'Only used with a custom schedule.'}>
              <input type="date" className="input mt-1 block w-44" disabled={u.preference !== 'custom'} value={u.nextUpgradeDate ?? ''} onChange={(e) => setU({ nextUpgradeDate: e.target.value || null })} />
            </Labelled>
            <Check label="In-app messages" hint="Show everyone a one-time message after an upgrade, with the version that is now running." checked={u.inAppMessages} onChange={(v) => setU({ inAppMessages: v })} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Current version">{system?.version ?? '…'}</Field>
            <Field label="Last upgraded date">{system ? fmtDate(system.lastUpgradedAt) : '…'}</Field>
            <Field label="Database schema">{system ? `${system.schema.latest ?? '—'} (${system.schema.count} migrations)` : '…'}</Field>
            <Field label="Server started">{system ? fmtDateTime(system.startedAt) : '…'}</Field>
            <Field label="Database">{system?.database === 'postgres' ? 'PostgreSQL' : system ? 'Embedded (PGlite)' : '…'}</Field>
            <Field label="Node">{system?.node ?? '…'}</Field>
          </div>
        </div>
      </Section>

      <Section title="Send Release Notes To" hint="Who should hear about a new release, with their email address.">
        <table className="w-full text-xs">
          <thead className="text-left text-slate-400">
            <tr className="border-b border-slate-200">
              <th className="py-1.5 pr-3 font-normal">Name</th>
              <th className="py-1.5 pr-3 font-normal">Email</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {u.releaseNotesRecipients.map((r, i) => (
              <tr key={`${r.email}-${i}`} className="border-b border-slate-100">
                <td className="py-1.5 pr-3">{r.name}</td>
                <td className="py-1.5 pr-3">{r.email}</td>
                <td className="py-1.5 text-right">
                  <button className="text-slate-400 hover:text-rose-600" onClick={() => setU({ releaseNotesRecipients: u.releaseNotesRecipients.filter((_, j) => j !== i) })}>
                    ✕
                  </button>
                </td>
              </tr>
            ))}
            {u.releaseNotesRecipients.length === 0 && (
              <tr>
                <td colSpan={3} className="py-3 text-center text-slate-400">
                  Nobody yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="text-xs text-slate-600">
            Name
            <input className="input mt-1 block w-48" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="text-xs text-slate-600">
            Email
            <input type="email" className="input mt-1 block w-64" value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addRecipient()} />
          </label>
          <button className="btn btn-sm" disabled={!name.trim() || !email.trim()} onClick={addRecipient}>
            Add
          </button>
        </div>
      </Section>
    </>
  );
}

/** A one-time banner after an upgrade: "version X is now running". */
export function UpgradeNotice() {
  const { settings } = useSettings();
  const [version, setVersion] = useState<string | null>(null);
  const key = 'sweyt:seenVersion';
  useEffect(() => {
    if (!settings.upgrades.inAppMessages) return;
    api
      .getSystemInfo()
      .then((s) => {
        let seen: string | null = null;
        try {
          seen = localStorage.getItem(key);
        } catch {
          /* private mode */
        }
        // First visit in this browser: remember the version quietly; the banner is for upgrades only.
        if (seen === null) {
          try {
            localStorage.setItem(key, s.version);
          } catch {
            /* private mode */
          }
        } else if (seen !== s.version) setVersion(s.version);
      })
      .catch(() => {});
  }, [settings.upgrades.inAppMessages]);
  if (!version) return null;
  const dismiss = () => {
    try {
      localStorage.setItem(key, version);
    } catch {
      /* ignore */
    }
    setVersion(null);
  };
  return (
    <div className="flex items-center gap-2 border-b border-emerald-200 bg-emerald-50 px-4 py-2 text-xs text-emerald-800">
      <span>
        <strong>New release.</strong> Sweyt Incentive {version} is now running.
      </span>
      <div className="flex-1" />
      <button className="underline" onClick={dismiss}>
        dismiss
      </button>
    </div>
  );
}

// -- Pieces -----------------------------------------------------------------------------------------

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="rounded-lg border border-slate-200 bg-panel">
      <div
        role="button"
        tabIndex={0}
        className="flex w-full cursor-pointer items-center gap-2 px-4 py-2 text-left text-sm font-semibold select-none"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setOpen((o) => !o))}
        aria-expanded={open}
      >
        <span className={`inline-block text-slate-400 transition-transform ${open ? 'rotate-90' : ''}`}>▸</span>
        {title}
        {hint && <span className="ml-2 text-xs font-normal text-slate-400">{hint}</span>}
      </div>
      {open && <div className="border-t border-slate-200 p-4">{children}</div>}
    </section>
  );
}

function Labelled({ label, required, hint, children }: { label: string; required?: boolean; hint?: string; children: ReactNode }) {
  return (
    <label className="block text-xs text-slate-600">
      <span className="text-[10px] font-medium tracking-wide text-slate-400 uppercase">
        {label}
        {required && <span className="ml-0.5 text-rose-600">*</span>}
      </span>
      {children}
      {hint && <span className="mt-1 block text-slate-400">{hint}</span>}
    </label>
  );
}

function Check({ label, hint, checked, onChange, soon }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; soon?: boolean }) {
  return (
    <label className="flex items-start gap-2 text-xs text-slate-600">
      <input type="checkbox" className="mt-0.5" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="text-[10px] font-medium tracking-wide text-slate-700 uppercase">
          {label}
          {soon && <span className="nav-soon ml-1 normal-case tracking-normal">soon</span>}
        </span>
        {hint && <span className="block text-slate-400">{hint}</span>}
      </span>
    </label>
  );
}

function Tool({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <div className="text-xs">
      <div className="text-slate-600">{label}</div>
      <div className="mt-0.5 text-sm">{children}</div>
      <div className="mt-0.5 text-slate-400">{hint}</div>
    </div>
  );
}

function ToolLink({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="text-indigo-600 hover:underline" onClick={onClick}>
      Tool link
    </button>
  );
}
