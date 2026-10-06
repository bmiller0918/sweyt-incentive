import type { ColumnDef, ColumnType, Criteria, PlanTiers, RawRow } from '@commissions/shared';

export interface ImportSummary {
  id: string;
  name: string;
  filename: string;
  sheetName: string | null;
  rowCount: number;
  createdAt: string;
}

export interface ImportDetail extends ImportSummary {
  headerRow: number;
  columns: ColumnDef[];
  warnings: string[];
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

export interface Employee {
  id: string;
  name: string;
  title: string | null;
  email: string | null;
  baseSalary: number | null;
  bonuses: { label: string; amount: number }[];
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

export type EmployeeInput = Omit<Employee, 'id' | 'assignments' | 'updatedAt'>;

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

  listEmployees: () => request<Employee[]>('/api/employees'),
  createEmployee: (body: EmployeeInput) => request<Employee>('/api/employees', json('POST', body)),
  bulkCreateEmployees: (names: string[]) => request<{ created: number }>('/api/employees/bulk', json('POST', { names })),
  updateEmployee: (id: string, body: EmployeeInput) => request<Employee>(`/api/employees/${id}`, json('PUT', body)),
  deleteEmployee: (id: string) => request<void>(`/api/employees/${id}`, { method: 'DELETE' }),
  addAssignment: (employeeId: string, body: { compPlanId: string; slot: string; effectiveFrom?: string | null; effectiveTo?: string | null }) =>
    request<PlanAssignment>(`/api/employees/${employeeId}/assignments`, json('POST', body)),
  updateAssignment: (id: string, body: { compPlanId: string; slot: string; effectiveFrom?: string | null; effectiveTo?: string | null }) =>
    request<PlanAssignment>(`/api/assignments/${id}`, json('PUT', body)),
  deleteAssignment: (id: string) => request<void>(`/api/assignments/${id}`, { method: 'DELETE' }),
};
