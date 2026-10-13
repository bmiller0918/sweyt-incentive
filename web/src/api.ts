import type {
  AccountMap,
  AccountingSettings,
  AmortizationMethodDef,
  AssetModification,
  AssetPosition,
  BookedLine,
  CloseResult,
  GlAccount,
  JournalEntry,
  MethodSchedule,
  RegisterAsset,
  RollforwardMonth,
} from '@commissions/shared';
import type { AccountingPolicy, Aggregate, AppSettings, ColumnDef, ColumnType, CostTreatment, Criteria, HoldRule, LineStatus, PayoutRule, PlanStructure, PlanTiers, RawRow, ScheduleLine, SubledgerResult } from '@commissions/shared';

export interface ImportSummary {
  id: string;
  name: string;
  filename: string;
  sheetName: string | null;
  rowCount: number;
  createdAt: string;
}

/** A column contributed by a linked import carries the source import's name. */
export type ImportColumn = ColumnDef & { linked?: string };

export interface ImportDetail extends ImportSummary {
  headerRow: number;
  columns: ImportColumn[];
  warnings: string[];
}

export interface ImportLink {
  id: string;
  childImportId: string;
  parentImportId: string;
  childKey: string;
  parentKey: string;
  parentFields: string[];
  aggregates: Aggregate[];
  parentName: string;
  childName: string;
  parentColumns: string[];
  childColumns: string[];
}

export interface LinkSummary {
  parent: ImportLink | null;
  children: ImportLink[];
}

export interface UploadResult {
  uploadId: string;
  filename: string;
  kind: 'csv' | 'excel';
  sheets: { name: string; rowCount: number; preview: string[][] }[];
}

export interface QueryResult {
  mode: 'detail' | 'summary';
  total: number;
  matched: number;
  /** Summary mode only: filtered detail rows and groups before HAVING. */
  detailMatched?: number;
  groupCount?: number;
  /** Summary mode only: the summary's output columns. */
  columns?: ColumnDef[];
  rows: { index: number; data: RawRow }[];
  impact: Record<string, number>;
  errors: Record<string, string>;
  totals: Record<string, { sum: number; count: number }>;
  /** Summary mode with a calc stage: rows whose rep had no plan. */
  calc?: { noPlan: number; asOf: string | null };
}

export interface GroupRowsResult {
  columns: ColumnDef[];
  rows: { index: number; data: RawRow }[];
  matched: number;
  subtotals: Record<string, { sum: number; count: number }>;
}

export type PlanParams = Record<string, number | string | boolean | null>;

export interface CompPlan {
  id: string;
  name: string;
  description: string | null;
  params: PlanParams;
  tiers: PlanTiers;
  /** Weighted components: target incentive split by weight, each with a quota and payout tiers. */
  structure: PlanStructure;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  employeeCount?: number;
  updatedAt: string;
}

export interface PlanAssignment {
  id: string;
  employeeId: string;
  compPlanId: string;
  planName: string;
  /** "plan" for the core plan; "spiff", "bonus", ... referenced as <slot>.<param> in formulas. */
  slot: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
}

export interface ThresholdType {
  id: string;
  key: string;
  name: string;
  unit: string;
  scaleParam: string | null;
  builtin: number;
}

export interface AppConfig {
  fiscalYearStartMonth: number;
  weekStartsOn: 0 | 1;
}

export interface TypeAssignment {
  id: string;
  employeeTypeId: string;
  compPlanId: string;
  planName: string;
  slot: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
}

export interface EmployeeType {
  id: string;
  name: string;
  description: string | null;
  defaultBaseSalary: number | null;
  defaultQuota: number | null;
  costTreatment: CostTreatment;
  amortizationTypeId: string | null;
  employeeCount: number;
  assignments: TypeAssignment[];
  updatedAt: string;
}
export type EmployeeTypeInput = Pick<EmployeeType, 'name' | 'description' | 'defaultBaseSalary' | 'defaultQuota' | 'costTreatment'> & { amortizationTypeId?: string | null };

export interface Employee {
  id: string;
  name: string;
  title: string | null;
  email: string | null;
  employeeTypeId: string | null;
  typeName?: string | null;
  baseSalary: number | null;
  quota: number | null;
  bonuses: { label: string; amount: number }[];
  /** Assignments contributed by the employee's type (read-only here). */
  inherited?: TypeAssignment[];
  notes: string | null;
  startDate: string | null;
  status: EmployeeStatus;
  statusDate: string | null;
  assignments: PlanAssignment[];
  updatedAt: string;
}

export const EMPLOYEE_STATUSES = ['active', 'terminated', 'parental_leave', 'medical_leave', 'leave', 'inactive'] as const;
export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number];
export const STATUS_LABELS: Record<EmployeeStatus, string> = {
  active: 'Active',
  terminated: 'Terminated',
  parental_leave: 'Parental leave',
  medical_leave: 'Medical leave',
  leave: 'Other leave',
  inactive: 'Inactive',
};

export type EmployeeInput = Omit<Employee, 'id' | 'assignments' | 'inherited' | 'typeName' | 'updatedAt'>;

/** A saved incentive: the whole filter → summarize → calculate pipeline for an import. */
export interface CriteriaSet {
  id: string;
  name: string;
  description: string | null;
  importId: string | null;
  importName?: string | null;
  criteria: Criteria;
  version: number;
  createdAt?: string;
  updatedAt: string;
}

export interface CommissionRunConfig {
  repField: string;
  payees: { role: string; field: string }[];
  amountField: string;
  dateField: string | null;
  dealKeyField: string | null;
  from: string | null;
  to: string | null;
  holdRules?: HoldRule[];
  payLagMonths?: number;
  contractStartField?: string | null;
  termMonthsField?: string | null;
  contractEndField?: string | null;
  /** Weighted-plan components → the column holding each one's value. */
  components?: { name: string; field: string }[];
}

/** The subledger as the API returns it: schedule lines without their per-month map. */
export type Subledger = Omit<SubledgerResult, 'schedule'> & { schedule: Omit<ScheduleLine, 'byMonth'>[] };
export type AccountingPolicyRow = AccountingPolicy & { id: string };

export interface HoldReason {
  id: string;
  key: string;
  name: string;
  builtin: number;
  sortOrder: number;
}

/** A saved payout rule, with its position (rules apply in order; the first flagging rule's reason wins). */
export type PayoutRuleRow = PayoutRule & { sortOrder: number; updatedAt: string };
export type PayoutRuleInput = Omit<PayoutRule, 'id'>;

/** A column header seen across imports, with the type most imports give it. */
export interface RuleField {
  name: string;
  type: ColumnType;
  imports: string[];
}

/** Dry run of the payout rules against one import. */
export interface PayoutRulesPreview {
  total: number;
  flaggedCount: number;
  counts: Record<string, number>;
  errors: Record<string, string>;
  skipped: string[];
  columns: ColumnDef[];
  rows: { index: number; ruleIds: string[]; data: RawRow }[];
}

export interface CommissionRun {
  id: string;
  name: string;
  importId: string | null;
  importName: string;
  config: CommissionRunConfig;
  dealCount: number;
  lineCount: number;
  totalPayout: number;
  warnings: string[];
  createdAt: string;
}

export interface CommissionLine {
  id: number;
  rowIndex: number;
  dealKey: string | null;
  dealDate: string | null;
  dealAmount: number | null;
  payee: string;
  role: string;
  planName: string | null;
  /** Plan component this line pays under (weighted plans); null for plan-level lines. */
  component: string | null;
  method: 'tier' | 'whole' | 'flat' | 'none';
  tierFrom: number | null;
  tierTo: number | null;
  amount: number | null;
  rate: number | null;
  payout: number | null;
  cumulativeBefore: number;
  cumulativeAfter: number;
  split: number;
  note: string | null;
  status: LineStatus;
  holdReason: string | null;
  holdNote: string | null;
  heldAt: string | null;
  releasedAt: string | null;
  payMonth: string | null;
}

export type CommissionRunInput = Omit<CommissionRunConfig, 'payees'> & { name: string; importId: string; payees: { role: string; field: string }[] };

/** Setup › Licensing. */
export interface SetupUsage {
  license: { edition: string; status: string; tierMax: number | null; countsTowardTier: number; syncedAt: string };
  usage: {
    employees: { active: number; leave: number; terminated: number; inactive: number; total: number };
    users: number;
    imports: { count: number; rows: number };
    compPlans: number;
    employeeTypes: number;
    incentives: number;
    runs: number;
    lines: { pay: number; hold: number; released: number; total: number };
    amortizations: { commission: number; manual: number; total: number };
    closedMonths: { count: number; latest: string | null };
  };
}

/** Setup › Manage Upgrades. */
export interface SystemInfo {
  version: string;
  schema: { count: number; latest: string | null };
  lastUpgradedAt: string | null;
  startedAt: string;
  database: 'postgres' | 'pglite';
  node: string;
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'member' | string;
  mustChangePassword: boolean;
}

/** Fired when any API call comes back 401, so the app can show the sign-in screen. */
export const UNAUTHORIZED_EVENT = 'sweyt:unauthorized';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (res.status === 401 && !url.startsWith('/api/auth/')) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const body = await res.json();
      msg = body.error ?? msg;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// -- Accounting --------------------------------------------------------------

export type AccountingSettingsRow = AccountingSettings & { id: string };
export interface AmortizationMethodRow {
  id: string;
  name: string;
  description: string | null;
  def: AmortizationMethodDef;
  builtinKey: string | null;
  usedBy: string[];
}
export type AmortizationMethodInput = { name: string; description: string | null; def: AmortizationMethodDef };
export interface AmortizationTypeRow {
  id: string;
  name: string;
  description: string | null;
  treatment: CostTreatment;
  methodId: string | null;
  expenseAccount: GlAccount | null;
  amortizationAccount: GlAccount | null;
  accounts: TypeAccountOverrides;
  defaultTermMonths: number | null;
  inactive: boolean;
  builtinKey: string | null;
  createdAt: string;
  updatedAt: string;
  employeeTypes: { id: string; name: string }[];
  /** Amortizations with a balance, and that balance, at the last closed month. */
  usage: { count: number; balance: number };
}
export type TypeAccountOverrides = Partial<Pick<AccountMap, 'deferredCurrent' | 'deferredNoncurrent' | 'impairmentExpense' | 'accruedCommissions'>>;
export type AmortizationTypeInput = Omit<AmortizationTypeRow, 'id' | 'builtinKey' | 'employeeTypes' | 'usage' | 'createdAt' | 'updatedAt'> & { employeeTypeIds?: string[] };
export interface RoleMapping {
  id: string;
  name: string;
  amortizationTypeId: string | null;
  costTreatment: CostTreatment;
  suggestedTypeId: string | null;
}
export interface AmortizationTypesPayload {
  /** Last closed month, for usage. */
  asOf: string | null;
  types: AmortizationTypeRow[];
  employeeTypes: RoleMapping[];
}
export interface PeriodRow {
  id: string;
  month: string;
  runIds: string[];
  currentPortion: number;
  closedBy: string | null;
  createdAt: string;
  entryCount: number;
  totals: CloseResult['totals'] | null;
  rollforward: RollforwardMonth | null;
}
export interface PeriodsPayload {
  periods: PeriodRow[];
  nextMonth: string;
  firstPayMonth: string | null;
  lastPayMonth: string | null;
}
export type ClosePreview = Omit<CloseResult, 'newAssets'> & {
  newAssets: Omit<RegisterAsset, 'byMonth'>[];
  runs: { id: string; name: string }[];
  unmapped: string[];
  balanced: boolean;
};
export type AssetStatusOrPending = AssetPosition['status'] | 'pending';
export interface AssetInfo {
  number: number;
  /** AMRT0001 */
  code: string;
  name: string;
  description: string | null;
  typeId: string | null;
  methodId: string | null;
  createdAt: string;
}
export type RegisterRow = Omit<RegisterAsset, 'byMonth'> & AssetInfo & Omit<AssetPosition, 'status'> & { status: AssetStatusOrPending };
export interface RegisterPayload {
  month: string;
  closed: boolean;
  rows: RegisterRow[];
  /** Manual amortizations waiting for their month's close. */
  pending: RegisterRow[];
  rollforward: RollforwardMonth;
  history: RollforwardMonth[];
  byType: { typeName: string; count: number; amount: number; remaining: number; current: number; noncurrent: number; amortizationThisMonth: number }[];
  waterfall: { year: string; amount: number }[];
  openMonth: string | null;
}
export interface ReclassRow {
  month: string;
  closing: number;
  current: number;
  noncurrent: number;
  reclass: { target: number; priorCurrent: number; beforeReclass: number; netMove: number } | null;
  entries: JournalEntry[];
}
export interface ManualAmortizationInput {
  name: string;
  payee: string;
  department: string;
  typeId: string | null;
  methodId: string | null;
  amount: number;
  capitalizedMonth: string;
  startMonth: string;
  months: number;
  description: string | null;
  dealKey: string | null;
  opening: boolean;
  offsetAccount: GlAccount | null;
  note?: string | null;
}
export type ScheduleState = 'booked' | 'next_close' | 'scheduled' | 'pending';
export interface AssetDetail extends Omit<RegisterAsset, 'byMonth' | 'bookedMonth'>, AssetInfo {
  bookedMonth: string | null;
  status: AssetStatusOrPending;
  runName: string | null;
  remaining: number;
  amortizedToDate: number;
  current: number;
  noncurrent: number;
  remainingPeriods: number;
  asOf: string | null;
  openMonth: string | null;
  schedule: { period: number; type: string; start: string; end: string; amount: number; remaining: number; journal: string | null; state: ScheduleState }[];
  accountRoles: { role: string; account: GlAccount; note: string }[];
  history: AssetModification[];
  editable: boolean;
}
export interface ReportAsset {
  id: string;
  code: string;
  name: string;
  origin: 'commission' | 'manual';
  payee: string;
  department: string;
  typeName: string;
}
export interface RollforwardReport {
  from: string;
  to: string;
  lastClosed: string | null;
  projected: boolean;
  rows: (ReportAsset & { initial: number; additions: number; amortization: number; writeOffs: number; ending: number })[];
}
export interface WaterfallReport {
  asOf: string;
  lastClosed: string | null;
  rows: (ReportAsset & { balance: number; byMonth: Record<string, number> })[];
}
export type { AssetModification, BookedLine, JournalEntry, MethodSchedule };

function download(href: string) {
  const a = document.createElement('a');
  a.href = href;
  a.click();
}

export const api = {
  upload(file: File, onProgress?: (pct: number) => void): Promise<UploadResult> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/uploads');
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => {
        try {
          const body = JSON.parse(xhr.responseText);
          if (xhr.status >= 200 && xhr.status < 300) resolve(body);
          else reject(new Error(body.error ?? xhr.statusText));
        } catch {
          reject(new Error(xhr.statusText || 'Upload failed'));
        }
      };
      xhr.onerror = () => reject(new Error('Network error during upload'));
      const fd = new FormData();
      fd.append('file', file);
      xhr.send(fd);
    });
  },
  commit(uploadId: string, body: { sheet?: string; headerRow: number; name?: string }) {
    return request<ImportDetail>(`/api/uploads/${uploadId}/commit`, json('POST', body));
  },
  listImports: () => request<ImportSummary[]>('/api/imports'),
  getImport: (id: string) => request<ImportDetail>(`/api/imports/${id}`),
  deleteImport: (id: string) => request<void>(`/api/imports/${id}`, { method: 'DELETE' }),
  patchImport: (id: string, body: { name?: string; columns?: { name: string; type: ColumnType }[] }) =>
    request<ImportDetail>(`/api/imports/${id}`, json('PATCH', body)),
  getLinks: (id: string) => request<LinkSummary>(`/api/imports/${id}/links`),
  setParentLink: (id: string, body: { parentImportId: string; childKey: string; parentKey: string; parentFields?: string[]; aggregates?: Aggregate[] }) =>
    request<LinkSummary>(`/api/imports/${id}/link`, json('PUT', body)),
  updateLink: (linkId: string, body: { parentFields?: string[]; aggregates?: Aggregate[] }) => request<ImportLink>(`/api/links/${linkId}`, json('PUT', body)),
  deleteLink: (linkId: string) => request<void>(`/api/links/${linkId}`, { method: 'DELETE' }),
  query: (
    id: string,
    body: {
      criteria?: Criteria;
      params?: Record<string, string>;
      mode?: 'detail' | 'summary';
      offset?: number;
      limit?: number;
      sort?: { field: string; dir: 'asc' | 'desc' };
    },
    signal?: AbortSignal,
  ) => request<QueryResult>(`/api/imports/${id}/query`, { ...json('POST', body), signal }),
  values: (
    id: string,
    body: { field: string; criteria?: Criteria; params?: Record<string, string>; search?: string; limit?: number },
    signal?: AbortSignal,
  ) =>
    request<{ values: { value: string; count: number }[]; distinct: number; truncated: boolean }>(`/api/imports/${id}/values`, {
      ...json('POST', body),
      signal,
    }),
  groupRows: (id: string, body: { criteria: Criteria; params?: Record<string, string>; groupValues: Record<string, string>; limit?: number }) =>
    request<GroupRowsResult>(`/api/imports/${id}/group-rows`, json('POST', body)),
  explain: (id: string, body: { criteria: Criteria; params?: Record<string, string>; rowIndex: number }) =>
    request<{ matched: boolean; conditions: Record<string, boolean> }>(`/api/imports/${id}/explain`, json('POST', body)),
  async export(id: string, body: { criteria?: Criteria; params?: Record<string, string>; mode?: 'detail' | 'summary'; format: 'csv' | 'xlsx' }) {
    const res = await fetch(`/api/imports/${id}/export`, json('POST', body));
    if (!res.ok) throw new Error((await res.json()).error ?? 'Export failed');
    const blob = await res.blob();
    const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? `export.${body.format}`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  },
  listCriteriaSets: (importId?: string) =>
    request<CriteriaSet[]>(`/api/criteria-sets${importId ? `?importId=${importId}` : ''}`),
  createCriteriaSet: (body: { name: string; description?: string | null; importId?: string | null; criteria: Criteria }) =>
    request<CriteriaSet>('/api/criteria-sets', json('POST', body)),
  updateCriteriaSet: (id: string, body: { name: string; description?: string | null; importId?: string | null; criteria: Criteria }) =>
    request<CriteriaSet>(`/api/criteria-sets/${id}`, json('PUT', body)),
  deleteCriteriaSet: (id: string) => request<void>(`/api/criteria-sets/${id}`, { method: 'DELETE' }),

  listPlans: () => request<CompPlan[]>('/api/comp-plans'),
  createPlan: (body: Omit<CompPlan, 'id' | 'updatedAt' | 'employeeCount'>) => request<CompPlan>('/api/comp-plans', json('POST', body)),
  updatePlan: (id: string, body: Omit<CompPlan, 'id' | 'updatedAt' | 'employeeCount'>) => request<CompPlan>(`/api/comp-plans/${id}`, json('PUT', body)),
  deletePlan: (id: string) => request<void>(`/api/comp-plans/${id}`, { method: 'DELETE' }),

  authStatus: () => request<{ setupRequired: boolean; user: AuthUser | null }>('/api/auth/status'),
  setup: (body: { email: string; name: string; password: string }) => request<{ user: AuthUser }>('/api/auth/setup', json('POST', body)),
  login: (body: { email: string; password: string }) => request<{ user: AuthUser }>('/api/auth/login', json('POST', body)),
  logout: () => request<void>('/api/auth/logout', { method: 'POST' }),
  changePassword: (body: { currentPassword: string; newPassword: string }) => request<{ ok: true }>('/api/auth/change-password', json('POST', body)),
  listUsers: () => request<(AuthUser & { lastLoginAt: string | null; createdAt: string })[]>('/api/users'),
  createUser: (body: { email: string; name: string; role: 'admin' | 'member' }) => request<{ user: AuthUser; tempPassword: string }>('/api/users', json('POST', body)),
  deleteUser: (id: string) => request<void>(`/api/users/${id}`, { method: 'DELETE' }),

  getConfig: () => request<AppConfig>('/api/config'),
  listThresholdTypes: () => request<ThresholdType[]>('/api/threshold-types'),
  createThresholdType: (body: { name: string; unit: string; scaleParam?: string | null }) => request<ThresholdType>('/api/threshold-types', json('POST', body)),
  deleteThresholdType: (id: string) => request<void>(`/api/threshold-types/${id}`, { method: 'DELETE' }),

  listEmployeeTypes: () => request<EmployeeType[]>('/api/employee-types'),
  createEmployeeType: (body: EmployeeTypeInput) => request<EmployeeType>('/api/employee-types', json('POST', body)),
  updateEmployeeType: (id: string, body: EmployeeTypeInput) => request<EmployeeType>(`/api/employee-types/${id}`, json('PUT', body)),
  deleteEmployeeType: (id: string) => request<void>(`/api/employee-types/${id}`, { method: 'DELETE' }),
  addTypeAssignment: (typeId: string, body: { compPlanId: string; slot: string; effectiveFrom?: string | null; effectiveTo?: string | null }) =>
    request<TypeAssignment>(`/api/employee-types/${typeId}/assignments`, json('POST', body)),
  updateTypeAssignment: (id: string, body: { compPlanId: string; slot: string; effectiveFrom?: string | null; effectiveTo?: string | null }) =>
    request<TypeAssignment>(`/api/type-assignments/${id}`, json('PUT', body)),
  deleteTypeAssignment: (id: string) => request<void>(`/api/type-assignments/${id}`, { method: 'DELETE' }),

  listEmployees: () => request<Employee[]>('/api/employees'),
  createEmployee: (body: EmployeeInput) => request<Employee>('/api/employees', json('POST', body)),
  bulkCreateEmployees: (names: string[], employeeTypeId?: string | null) =>
    request<{ created: number }>('/api/employees/bulk', json('POST', { names, employeeTypeId: employeeTypeId ?? null })),
  updateEmployee: (id: string, body: EmployeeInput) => request<Employee>(`/api/employees/${id}`, json('PUT', body)),
  deleteEmployee: (id: string) => request<void>(`/api/employees/${id}`, { method: 'DELETE' }),
  addAssignment: (employeeId: string, body: { compPlanId: string; slot: string; effectiveFrom?: string | null; effectiveTo?: string | null }) =>
    request<PlanAssignment>(`/api/employees/${employeeId}/assignments`, json('POST', body)),
  updateAssignment: (id: string, body: { compPlanId: string; slot: string; effectiveFrom?: string | null; effectiveTo?: string | null }) =>
    request<PlanAssignment>(`/api/assignments/${id}`, json('PUT', body)),
  deleteAssignment: (id: string) => request<void>(`/api/assignments/${id}`, { method: 'DELETE' }),

  listCommissionRuns: () => request<CommissionRun[]>('/api/commission-runs'),
  getCommissionRun: (id: string) => request<CommissionRun & { lines: CommissionLine[] }>(`/api/commission-runs/${id}`),
  createCommissionRun: (body: CommissionRunInput) => request<CommissionRun>('/api/commission-runs', json('POST', body)),
  deleteCommissionRun: (id: string) => request<void>(`/api/commission-runs/${id}`, { method: 'DELETE' }),
  exportCommissionRun(id: string, status?: LineStatus) {
    const a = document.createElement('a');
    a.href = `/api/commission-runs/${id}/export${status ? `?status=${status}` : ''}`;
    a.click();
  },
  holdLines: (runId: string, body: { lineIds: number[]; reasonKey: string; note?: string | null; heldAt?: string }) =>
    request<CommissionLine[]>(`/api/commission-runs/${runId}/hold`, json('POST', body)),
  releaseLines: (runId: string, body: { lineIds: number[]; releasedAt?: string; note?: string | null }) =>
    request<CommissionLine[]>(`/api/commission-runs/${runId}/release`, json('POST', body)),
  payLines: (runId: string, lineIds: number[]) => request<CommissionLine[]>(`/api/commission-runs/${runId}/pay`, json('POST', { lineIds })),

  getAccounting: (runId: string) => request<Subledger>(`/api/commission-runs/${runId}/accounting`),
  exportAccounting(runId: string, what: 'schedule' | 'entries') {
    const a = document.createElement('a');
    a.href = `/api/commission-runs/${runId}/accounting/${what}.csv`;
    a.click();
  },
  getAccountingPolicy: () => request<AccountingPolicyRow>('/api/accounting-policy'),
  updateAccountingPolicy: (body: AccountingPolicy) => request<AccountingPolicyRow>('/api/accounting-policy', json('PUT', body)),

  listPayoutRules: () => request<PayoutRuleRow[]>('/api/payout-rules'),
  listRuleFields: () => request<RuleField[]>('/api/payout-rules/fields'),
  createPayoutRule: (body: PayoutRuleInput) => request<PayoutRuleRow>('/api/payout-rules', json('POST', body)),
  updatePayoutRule: (id: string, body: PayoutRuleInput) => request<PayoutRuleRow>(`/api/payout-rules/${id}`, json('PUT', body)),
  reorderPayoutRules: (ids: string[]) => request<PayoutRuleRow[]>('/api/payout-rules/order', json('PUT', { ids })),
  deletePayoutRule: (id: string) => request<void>(`/api/payout-rules/${id}`, { method: 'DELETE' }),
  previewPayoutRules: (body: { importId: string; rules?: PayoutRule[]; limit?: number }) => request<PayoutRulesPreview>('/api/payout-rules/preview', json('POST', body)),

  getAccountingSettings: () => request<AccountingSettingsRow>('/api/accounting-settings'),
  updateAccountingSettings: (body: AccountingSettings) => request<AccountingSettingsRow>('/api/accounting-settings', json('PUT', body)),
  listMethods: () => request<AmortizationMethodRow[]>('/api/amortization-methods'),
  createMethod: (body: AmortizationMethodInput) => request<AmortizationMethodRow>('/api/amortization-methods', json('POST', body)),
  updateMethod: (id: string, body: AmortizationMethodInput) => request<AmortizationMethodRow>(`/api/amortization-methods/${id}`, json('PUT', body)),
  deleteMethod: (id: string) => request<void>(`/api/amortization-methods/${id}`, { method: 'DELETE' }),
  previewMethod: (body: { def: AmortizationMethodDef; amount: number; payMonth: string; contractStart: string | null; termMonths: number | null; practicalExpedient: boolean }) =>
    request<{ errors: string[]; schedule: MethodSchedule | null }>('/api/amortization-methods/preview', json('POST', body)),
  listAmortizationTypes: () => request<AmortizationTypesPayload>('/api/amortization-types'),
  createAmortizationType: (body: AmortizationTypeInput) => request<AmortizationTypesPayload>('/api/amortization-types', json('POST', body)),
  updateAmortizationType: (id: string, body: AmortizationTypeInput) => request<AmortizationTypesPayload>(`/api/amortization-types/${id}`, json('PUT', body)),
  deleteAmortizationType: (id: string) => request<AmortizationTypesPayload>(`/api/amortization-types/${id}`, { method: 'DELETE' }),
  assignAmortizationTypes: (assignments: { employeeTypeId: string; amortizationTypeId: string | null }[]) =>
    request<AmortizationTypesPayload>('/api/amortization-types/assign', json('POST', { assignments })),
  listPeriods: () => request<PeriodsPayload>('/api/accounting/periods'),
  previewClose: (month: string, runIds: string[] | null) => request<ClosePreview>(`/api/accounting/close/${month}${runIds ? `?runIds=${runIds.join(',')}` : ''}`),
  closeMonth: (month: string, runIds: string[] | null) => request<{ month: string }>(`/api/accounting/close/${month}`, json('POST', { runIds })),
  reopenMonth: (month: string, force = false) => request<{ ok: true }>(`/api/accounting/periods/${month}/reopen`, json('POST', { force })),
  getJournals: (month: string) => request<{ month: string; closed: boolean; entries: JournalEntry[] }>(`/api/accounting/journals/${month}`),
  exportJournals: (month: string) => download(`/api/accounting/journals/${month}/entries.csv`),
  getRegister: (month?: string) => request<RegisterPayload>(`/api/accounting/register${month ? `?month=${month}` : ''}`),
  exportRegister: (month: string) => download(`/api/accounting/register.csv?month=${month}`),
  exportSchedule: () => download('/api/accounting/register/schedule.csv'),
  getAsset: (id: string) => request<AssetDetail>(`/api/accounting/assets/${id}`),
  previewAsset: (body: ManualAmortizationInput) =>
    request<{ startMonth: string; endMonth: string; months: number; byMonth: Record<string, number> }>('/api/accounting/assets/preview', json('POST', body)),
  createAsset: (body: ManualAmortizationInput) => request<{ id: string; code: string }>('/api/accounting/assets', json('POST', body)),
  updateAsset: (id: string, body: Partial<ManualAmortizationInput> & { endMonth?: string; note?: string | null }) => request<{ ok: true }>(`/api/accounting/assets/${id}`, json('PUT', body)),
  transferAsset: (id: string, body: { department: string; typeId: string | null; note: string | null }) => request<{ ok: true }>(`/api/accounting/assets/${id}/transfer`, json('POST', body)),
  deleteAsset: (id: string) => request<{ ok: true }>(`/api/accounting/assets/${id}`, { method: 'DELETE' }),
  rollforwardReport: (from: string, to: string) => request<RollforwardReport>(`/api/accounting/reports/rollforward?from=${from}&to=${to}`),
  waterfallReport: (asOf?: string) => request<WaterfallReport>(`/api/accounting/reports/waterfall${asOf ? `?asOf=${asOf}` : ''}`),
  writeOffAsset: (id: string, reason: string) => request<{ writtenOffMonth: string }>(`/api/accounting/assets/${id}/write-off`, json('POST', { reason })),
  undoWriteOff: (id: string) => request<{ ok: true }>(`/api/accounting/assets/${id}/write-off`, { method: 'DELETE' }),
  getReclass: () => request<ReclassRow[]>('/api/accounting/reclass'),

  getSettings: () => request<AppSettings>('/api/settings'),
  updateSettings: (body: AppSettings) => request<AppSettings>('/api/settings', json('PUT', body)),
  getSetupUsage: () => request<SetupUsage>('/api/setup/usage'),
  getSystemInfo: () => request<SystemInfo>('/api/setup/system'),
  templateUrl: (name: 'deals' | 'payments') => `/api/setup/templates/${name}`,

  listHoldReasons: () => request<HoldReason[]>('/api/hold-reasons'),
  createHoldReason: (name: string) => request<HoldReason>('/api/hold-reasons', json('POST', { name })),
  deleteHoldReason: (id: string) => request<void>(`/api/hold-reasons/${id}`, { method: 'DELETE' }),
};
