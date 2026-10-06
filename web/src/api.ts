import type { ColumnDef, ColumnType, Criteria, RawRow } from '@commissions/shared';

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
  calc?: { noPlan: number };
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
  effectiveFrom: string | null;
  effectiveTo: string | null;
  repCount?: number;
  updatedAt: string;
}

export interface RepAssignment {
  id: string;
  repName: string;
  compPlanId: string;
  planName: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
}

export interface CriteriaSet {
  id: string;
  name: string;
  description: string | null;
  importId: string | null;
  criteria: Criteria;
  version: number;
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
  createCriteriaSet: (body: { name: string; description?: string; importId?: string | null; criteria: Criteria }) =>
    request<CriteriaSet>('/api/criteria-sets', json('POST', body)),
  updateCriteriaSet: (id: string, body: { name: string; description?: string; importId?: string | null; criteria: Criteria }) =>
    request<CriteriaSet>(`/api/criteria-sets/${id}`, json('PUT', body)),
  deleteCriteriaSet: (id: string) => request<void>(`/api/criteria-sets/${id}`, { method: 'DELETE' }),

  listPlans: () => request<CompPlan[]>('/api/comp-plans'),
  createPlan: (body: Omit<CompPlan, 'id' | 'updatedAt' | 'repCount'>) => request<CompPlan>('/api/comp-plans', json('POST', body)),
  updatePlan: (id: string, body: Omit<CompPlan, 'id' | 'updatedAt' | 'repCount'>) => request<CompPlan>(`/api/comp-plans/${id}`, json('PUT', body)),
  deletePlan: (id: string) => request<void>(`/api/comp-plans/${id}`, { method: 'DELETE' }),
  listAssignments: () => request<RepAssignment[]>('/api/rep-assignments'),
  createAssignment: (body: { repName: string; compPlanId: string; effectiveFrom?: string | null; effectiveTo?: string | null }) =>
    request<RepAssignment>('/api/rep-assignments', json('POST', body)),
  bulkAssign: (body: { compPlanId: string; repNames: string[]; effectiveFrom?: string | null; effectiveTo?: string | null }) =>
    request<{ created: number }>('/api/rep-assignments/bulk', json('POST', body)),
  updateAssignment: (id: string, body: { repName: string; compPlanId: string; effectiveFrom?: string | null; effectiveTo?: string | null }) =>
    request<RepAssignment>(`/api/rep-assignments/${id}`, json('PUT', body)),
  deleteAssignment: (id: string) => request<void>(`/api/rep-assignments/${id}`, { method: 'DELETE' }),
};
