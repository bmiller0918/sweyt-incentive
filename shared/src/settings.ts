// Global settings: one JSON document edited on the Setup page (General,
// System Features, Import Tools, Licensing, Manage Upgrades). Modelled on
// NetAsset's global settings, keeping only what applies to commissions.
import { z } from 'zod';

// -- System features ---------------------------------------------------------

/** A feature that can be switched off; the sidebar and the pages hide what it covers. */
export interface FeatureDef {
  key: FeatureKey;
  label: string;
  hint: string;
  /** Not built yet: the sidebar shows a "soon" placeholder while it is on. */
  planned?: boolean;
}

export const FEATURE_KEYS = [
  'accounting',
  'holds',
  'incentives',
  'weightedComponents',
  'linkedImports',
  'integrations',
  'recasts',
  'clawbacks',
  'reporting',
  'statements',
  'planDesign',
] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

export const FEATURES: FeatureDef[] = [
  { key: 'accounting', label: 'Accounting subledger', hint: 'Capitalize or expense commissions, amortization register, monthly close and journals. Off hides the Accounting section and the Accounting tab on a run.' },
  { key: 'holds', label: 'Payout holds', hint: 'Payout rules, hold rules, the on-hold dashboard and hold reasons. Off hides Payout Rules and Payouts On Hold.' },
  { key: 'incentives', label: 'Spiffs, accelerators and bonus plans', hint: 'Saved incentive pipelines (period, filters, summary, calculations) on an import.' },
  { key: 'weightedComponents', label: 'Weighted plan components', hint: 'Split a plan’s target incentive across components with their own quotas and attainment tiers. Off hides the component editor on a plan.' },
  { key: 'linkedImports', label: 'Linked imports', hint: 'Parent / child imports on a key column, with the parent’s fields and child roll-ups available everywhere. Off hides the Links button on an import.' },
  { key: 'integrations', label: 'Integrations', hint: 'CRM and ERP connectors.', planned: true },
  { key: 'recasts', label: 'Mid-year recasts', hint: 'Re-plan quotas and rates part-way through the year.', planned: true },
  { key: 'clawbacks', label: 'Clawbacks', hint: 'Recover paid commission on churned or cancelled deals.', planned: true },
  { key: 'reporting', label: 'Reporting', hint: 'Leadership reporting across runs and periods.', planned: true },
  { key: 'statements', label: 'Employee statements', hint: 'Per-person commission statements.', planned: true },
  { key: 'planDesign', label: 'Annual plan design', hint: 'Model next year’s plans against this year’s data.', planned: true },
];

// -- Quick access buttons ------------------------------------------------------

export const QUICK_ACTION_KEYS = ['holdLines', 'releaseLines', 'payNow', 'exportLines', 'exportOnHold', 'exportSchedule', 'exportEntries', 'deleteRun'] as const;
export type QuickActionKey = (typeof QUICK_ACTION_KEYS)[number];

export interface QuickActionDef {
  key: QuickActionKey;
  label: string;
  hint: string;
}

/** Buttons on a commission run that can be switched off. */
export const QUICK_ACTIONS: QuickActionDef[] = [
  { key: 'holdLines', label: 'Hold lines', hint: 'A "Hold" button on selected lines and on each payable line, putting them on hold with a reason.' },
  { key: 'releaseLines', label: 'Release lines', hint: 'A "Release" button on held lines; they pay on the payroll after the release date.' },
  { key: 'payNow', label: 'Clear hold (pay now)', hint: 'A "Pay now" link on a held line that clears the hold as if it was never held.' },
  { key: 'exportLines', label: 'Export CSV', hint: 'Download every line of the run.' },
  { key: 'exportOnHold', label: 'Export on-hold CSV', hint: 'Download just the lines on hold.' },
  { key: 'exportSchedule', label: 'Export amortization schedule', hint: 'On the run’s Accounting tab: the schedule with one column per month.' },
  { key: 'exportEntries', label: 'Export journal entries', hint: 'On the run’s Accounting tab: the accrual and amortization entries.' },
  { key: 'deleteRun', label: 'Delete run', hint: 'A "Delete" button on the run header.' },
];

// -- Restrict feature permissions ------------------------------------------------

export const PERMISSION_KEYS = ['imports', 'incentives', 'plans', 'employees', 'runs', 'holds', 'accounting', 'close'] as const;
export type PermissionKey = (typeof PERMISSION_KEYS)[number];
export type PermissionLevel = 'all' | 'admin';

export interface PermissionDef {
  key: PermissionKey;
  label: string;
  hint: string;
}

/** Things a signed-in user can do; each can be restricted to admins. Reading is always open to everyone signed in. */
export const PERMISSIONS: PermissionDef[] = [
  { key: 'imports', label: 'Import data', hint: 'Upload files, rename or delete imports, change column types, link imports.' },
  { key: 'incentives', label: 'Save incentives', hint: 'Create, change and delete saved incentive pipelines.' },
  { key: 'plans', label: 'Edit comp plans', hint: 'Comp plans, threshold types, employee types and their default plan assignments.' },
  { key: 'employees', label: 'Edit employees', hint: 'Add, change and remove employees and their plan assignments.' },
  { key: 'runs', label: 'Calculate commission runs', hint: 'Create and delete commission runs.' },
  { key: 'holds', label: 'Hold and release payouts', hint: 'Put lines on hold, release them, clear holds, and manage hold reasons and payout rules.' },
  { key: 'accounting', label: 'Edit accounting setup and register', hint: 'Accounting settings, amortization methods and types, amortization records, write-offs and transfers.' },
  { key: 'close', label: 'Close and reopen months', hint: 'Process Monthly Accounting: close a month, reopen the latest closed month.' },
];

// -- Manage upgrades -------------------------------------------------------------

export const UPGRADE_PREFERENCES = ['automatic', 'annual', 'semi_annual', 'custom'] as const;
export type UpgradePreference = (typeof UPGRADE_PREFERENCES)[number];
export const UPGRADE_PREFERENCE_LABELS: Record<UpgradePreference, string> = {
  automatic: 'Accept all — every release as it ships',
  annual: 'Annual upgrades',
  semi_annual: 'Semi-annual upgrades',
  custom: 'Custom date',
};

// -- The schema ------------------------------------------------------------------

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

const flags = <K extends string>(keys: readonly K[], dflt: boolean) =>
  z.object(Object.fromEntries(keys.map((k) => [k, z.boolean().default(dflt)])) as Record<K, z.ZodDefault<z.ZodBoolean>>);

export const appSettingsSchema = z.object({
  general: z
    .object({
      /** Commissions and journals are processed from this date; earlier payouts are opening balances. */
      goLiveDate: isoDate.nullable().default(null),
      fiscalYearStartMonth: z.number().int().min(1).max(12).default(1),
      weekStartsOn: z.union([z.literal(0), z.literal(1)]).default(1),
      /** Months between a deal's close (or a release) and the payroll it pays on. */
      defaultPayLagMonths: z.number().int().min(0).max(12).default(1),
      /** Let users enter amortization records by hand, outside the monthly close. */
      allowManualAmortizations: z.boolean().default(true),
      /** Amortization record ids: AMRT0001. */
      amortizationPrefix: z
        .string()
        .trim()
        .min(1)
        .max(10)
        .regex(/^[A-Za-z0-9_-]+$/, 'Letters, digits, - and _ only')
        .default('AMRT'),
      amortizationMinDigits: z.number().int().min(1).max(10).default(4),
      /** Let a release be dated so that it pays in a month that is already closed. */
      allowReleaseIntoClosedMonth: z.boolean().default(false),
      /** Let the latest closed month be reopened (a journal deletion control when off). */
      allowReopenClosedMonth: z.boolean().default(true),
    })
    .default({}),
  features: flags(FEATURE_KEYS, true).default({}),
  quickActions: flags(QUICK_ACTION_KEYS, true).default({}),
  permissions: z.object(Object.fromEntries(PERMISSION_KEYS.map((k) => [k, z.enum(['all', 'admin']).default('all')])) as Record<PermissionKey, z.ZodDefault<z.ZodEnum<['all', 'admin']>>>).default({}),
  upgrades: z
    .object({
      preference: z.enum(UPGRADE_PREFERENCES).default('automatic'),
      nextUpgradeDate: isoDate.nullable().default(null),
      /** Show a "what's new" message in the app after an upgrade. */
      inAppMessages: z.boolean().default(true),
      releaseNotesRecipients: z.array(z.object({ name: z.string().trim().min(1).max(120), email: z.string().trim().email().max(200) })).max(50).default([]),
    })
    .default({}),
});

export type AppSettings = z.infer<typeof appSettingsSchema>;

/** Every default, for a fresh install or an unknown key. */
export const DEFAULT_APP_SETTINGS: AppSettings = appSettingsSchema.parse({});

/**
 * Fill in whatever a stored document is missing (new keys after an upgrade)
 * and drop what it no longer has. Unknown values fail validation.
 */
export function normalizeSettings(stored: unknown): AppSettings {
  return appSettingsSchema.parse(stored ?? {});
}

/** AMRT0001-style id with the configured prefix and width. */
export function formatRecordNumber(n: number, prefix: string, minDigits: number): string {
  return `${prefix}${String(n).padStart(minDigits, '0')}`;
}

/** YYYY-MM of an ISO date, or null. */
export const monthOf = (iso: string | null | undefined): string | null => (iso ? iso.slice(0, 7) : null);
