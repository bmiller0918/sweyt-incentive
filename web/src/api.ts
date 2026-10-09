import type { AccountingPolicy, Aggregate, ColumnDef, ColumnType, CostTreatment, Criteria, HoldRule, LineStatus, PlanTiers, RawRow, ScheduleLine, SubledgerResult } from '@commissions/shared';

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
  employeeCount: number;
  assignments: TypeAssignment[];
  updatedAt: string;
}
export type EmployeeTypeInput = Pick<EmployeeType, 'name' | 'description' | 'defaultBaseSalary' | 'defaultQuota' | 'costTreatment'>;

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

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
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

  listHoldReasons: () => request<HoldReason[]>('/api/hold-reasons'),
  createHoldReason: (name: string) => request<HoldReason>('/api/hold-reasons', json('POST', { name })),
  deleteHoldReason: (id: string) => request<void>(`/api/hold-reasons/${id}`, { method: 'DELETE' }),
};
