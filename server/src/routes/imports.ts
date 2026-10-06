import { randomUUID } from 'node:crypto';
import {
  COLUMN_TYPES,
  columnTotals,
  compileCriteria,
  conditionImpact,
  criteriaSchema,
  groupKey,
  groupKeyFromValues,
  inferColumnType,
  isSummaryActive,
  summarize,
  summaryColumns,
  validateCriteria,
  type ColumnDef,
  type Criteria,
  type RawRow,
  type TypedRow,
  type TypedValue,
} from '@commissions/shared';
import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import type { Db } from '../db/client.js';
import { auditLog, importRows, imports } from '../db/schema.js';
import { toCsv, toXlsx } from '../export.js';
import { applyHeaderRow, parseBuffer, type ParsedFile } from '../parse.js';
import { getRows, invalidate } from '../rowcache.js';

// Uploads wait here (in memory, 15 min) between "parse" and "commit", so the
// user can pick a sheet and header row without us touching local disk.
const pending = new Map<string, { parsed: ParsedFile; filename: string; expires: number }>();
const PENDING_TTL_MS = 15 * 60 * 1000;

function sweepPending() {
  const now = Date.now();
  for (const [id, p] of pending) if (p.expires < now) pending.delete(id);
}

const BATCH = 1000;

const querySchema = z.object({
  criteria: criteriaSchema.optional(),
  params: z.record(z.string()).optional(),
  /** 'summary' rolls the filtered rows up using criteria.summary. */
  mode: z.enum(['detail', 'summary']).default('detail'),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(5000).default(500),
  sort: z.object({ field: z.string(), dir: z.enum(['asc', 'desc']) }).optional(),
});

function sortIndices(indices: number[], typed: TypedRow[], sort: { field: string; dir: 'asc' | 'desc' } | undefined, types: Record<string, unknown>) {
  if (!sort || !(sort.field in types)) return;
  const f = sort.field;
  const dir = sort.dir === 'asc' ? 1 : -1;
  indices.sort((a, b) => dir * compareTyped(typed[a][f], typed[b][f]));
}

/** Validate HAVING against the summary's output columns. */
function havingErrors(criteria: Criteria, types: Record<string, ColumnDef['type']>, ctx: Parameters<typeof validateCriteria>[1]) {
  if (!isSummaryActive(criteria.summary) || !criteria.summary.having) return {};
  const outTypes = Object.fromEntries(summaryColumns(criteria.summary, types).map((c) => [c.name, c.type]));
  return validateCriteria({ version: 1, root: criteria.summary.having }, { ...ctx, types: outTypes });
}

function compareTyped(a: TypedValue, b: TypedValue): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1; // nulls last
  if (b === null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

function dataQualityWarnings(headers: string[], records: RawRow[]): string[] {
  const warnings: string[] = [];
  const seen = new Set<string>();
  let dupes = 0;
  for (const r of records) {
    const key = headers.map((h) => r[h]).join('\u0001');
    if (seen.has(key)) dupes++;
    else seen.add(key);
  }
  if (dupes > 0) warnings.push(`${dupes} exact duplicate row${dupes === 1 ? '' : 's'} found (kept, not removed).`);
  const generated = headers.filter((h) => /^Column \d+$/.test(h));
  if (generated.length) warnings.push(`${generated.length} blank header${generated.length === 1 ? '' : 's'} auto-named.`);
  return warnings;
}

export async function importRoutes(app: FastifyInstance, db: Db) {
  const evalCtx = (types: Record<string, ColumnDef['type']>, params?: Record<string, string>) => ({
    types,
    params,
    fiscalYearStartMonth: config.fiscalYearStartMonth,
    weekStartsOn: config.weekStartsOn,
  });

  // -- Upload: parse and hold ------------------------------------------------
  app.post('/api/uploads', async (req, reply) => {
    sweepPending();
    const file = await req.file({ limits: { fileSize: config.maxUploadBytes } });
    if (!file) return reply.code(400).send({ error: 'No file uploaded' });
    const buf = await file.toBuffer();
    if (file.file.truncated) {
      return reply.code(413).send({ error: `File exceeds ${config.maxUploadBytes / 1024 / 1024} MB limit` });
    }
    let parsed: ParsedFile;
    try {
      parsed = parseBuffer(buf);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    const id = randomUUID();
    pending.set(id, { parsed, filename: file.filename, expires: Date.now() + PENDING_TTL_MS });
    return {
      uploadId: id,
      filename: file.filename,
      kind: parsed.kind,
      sheets: parsed.sheets.map((s) => ({ name: s.name, rowCount: s.rows.length, preview: s.rows.slice(0, 25) })),
    };
  });

  // -- Commit: choose sheet + header row, infer types, store rows -----------
  const commitSchema = z.object({
    sheet: z.string().optional(),
    headerRow: z.number().int().min(0).default(0),
    name: z.string().min(1).optional(),
  });
  app.post('/api/uploads/:id/commit', async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = pending.get(id);
    if (!p) return reply.code(404).send({ error: 'Upload expired or not found. Please upload again.' });
    const body = commitSchema.parse(req.body);
    const sheet = p.parsed.sheets.find((s) => s.name === body.sheet) ?? p.parsed.sheets[0];
    if (!sheet) return reply.code(400).send({ error: 'Workbook has no sheets' });

    const { headers, records } = applyHeaderRow(sheet.rows, body.headerRow);
    if (headers.length === 0) return reply.code(400).send({ error: 'No columns found at that header row' });

    const columns: ColumnDef[] = headers.map((name, index) => {
      const inferred = inferColumnType(records.map((r) => r[name]));
      return { name, index, type: inferred, inferredType: inferred };
    });

    const [row] = await db
      .insert(imports)
      .values({
        name: body.name ?? p.filename.replace(/\.[^.]+$/, ''),
        filename: p.filename,
        sheetName: p.parsed.kind === 'excel' ? sheet.name : null,
        headerRow: body.headerRow,
        rowCount: records.length,
        columns,
        warnings: dataQualityWarnings(headers, records),
      })
      .returning();

    for (let i = 0; i < records.length; i += BATCH) {
      const chunk = records.slice(i, i + BATCH).map((data, j) => ({ importId: row.id, rowIndex: i + j, data }));
      await db.insert(importRows).values(chunk);
    }
    await db.insert(auditLog).values({ action: 'import.create', entityType: 'import', entityId: row.id, detail: { rows: records.length } });
    pending.delete(id);
    return row;
  });

  // -- Imports CRUD ----------------------------------------------------------
  app.get('/api/imports', async () => {
    return db
      .select({
        id: imports.id,
        name: imports.name,
        filename: imports.filename,
        sheetName: imports.sheetName,
        rowCount: imports.rowCount,
        createdAt: imports.createdAt,
      })
      .from(imports)
      .orderBy(desc(imports.createdAt));
  });

  app.get('/api/imports/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [row] = await db.select().from(imports).where(eq(imports.id, id));
    if (!row) return reply.code(404).send({ error: 'Import not found' });
    return row;
  });

  app.delete('/api/imports/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await db.delete(imports).where(eq(imports.id, id));
    invalidate(id);
    await db.insert(auditLog).values({ action: 'import.delete', entityType: 'import', entityId: id });
    return reply.code(204).send();
  });

  const patchSchema = z.object({
    name: z.string().min(1).optional(),
    columns: z.array(z.object({ name: z.string(), type: z.enum(COLUMN_TYPES) })).optional(),
  });
  app.patch('/api/imports/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = patchSchema.parse(req.body);
    const [current] = await db.select().from(imports).where(eq(imports.id, id));
    if (!current) return reply.code(404).send({ error: 'Import not found' });
    const columns = body.columns
      ? current.columns.map((c) => {
          const o = body.columns!.find((x) => x.name === c.name);
          return o ? { ...c, type: o.type } : c;
        })
      : current.columns;
    const [row] = await db
      .update(imports)
      .set({ name: body.name ?? current.name, columns, updatedAt: new Date() })
      .where(eq(imports.id, id))
      .returning();
    invalidate(id);
    return row;
  });

  // -- Query: filter, sort, paginate, impact ---------------------------------
  app.post('/api/imports/:id/query', async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = querySchema.parse(req.body ?? {});
    const [imp] = await db.select().from(imports).where(eq(imports.id, id));
    if (!imp) return reply.code(404).send({ error: 'Import not found' });

    const cached = await getRows(db, id, imp.columns);
    const ctx = evalCtx(cached.types, q.params);

    let indices: number[];
    let impact: Record<string, number> = {};
    let errors: Record<string, string> = {};
    if (q.criteria) {
      errors = { ...validateCriteria(q.criteria, ctx), ...havingErrors(q.criteria, cached.types, ctx) };
      if (Object.keys(errors).length) {
        // Don't evaluate a broken tree; show everything and surface errors.
        indices = cached.typed.map((_, i) => i);
      } else {
        const compiled = compileCriteria(q.criteria, ctx);
        indices = [];
        for (let i = 0; i < cached.typed.length; i++) if (compiled.matches(cached.typed[i])) indices.push(i);
        impact = conditionImpact(cached.typed, q.criteria, ctx).impact;
      }
    } else {
      indices = cached.typed.map((_, i) => i);
    }

    // Summary mode: roll up, then sort/page the summary rows instead.
    if (q.mode === 'summary' && q.criteria && isSummaryActive(q.criteria.summary) && !Object.keys(errors).length) {
      const s = summarize(cached.raw, cached.typed, indices, q.criteria.summary, ctx);
      const outTypes = Object.fromEntries(s.columns.map((c) => [c.name, c.type]));
      const sIdx = s.raw.map((_, i) => i);
      sortIndices(sIdx, s.typed, q.sort, outTypes);
      const page = sIdx.slice(q.offset, q.offset + q.limit).map((i) => ({ index: i, data: s.raw[i] }));
      return {
        mode: 'summary',
        total: cached.raw.length,
        detailMatched: indices.length,
        groupCount: s.groupCount,
        matched: s.raw.length,
        columns: s.columns,
        rows: page,
        impact,
        errors,
        totals: columnTotals(s.typed, sIdx, outTypes),
      };
    }

    sortIndices(indices, cached.typed, q.sort, cached.types);
    const page = indices.slice(q.offset, q.offset + q.limit).map((i) => ({ index: i, data: cached.raw[i] }));
    return {
      mode: 'detail',
      total: cached.raw.length,
      matched: indices.length,
      rows: page,
      impact,
      errors,
      totals: columnTotals(cached.typed, indices, cached.types),
    };
  });

  // -- Drill-down: the detail rows behind one summary row -------------------
  const groupRowsSchema = z.object({
    criteria: criteriaSchema,
    params: z.record(z.string()).optional(),
    /** Group-by column -> the value shown on the summary row. */
    groupValues: z.record(z.string()),
    limit: z.number().int().min(1).max(5000).default(1000),
  });
  app.post('/api/imports/:id/group-rows', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = groupRowsSchema.parse(req.body);
    const [imp] = await db.select().from(imports).where(eq(imports.id, id));
    if (!imp) return reply.code(404).send({ error: 'Import not found' });
    if (!isSummaryActive(body.criteria.summary)) return reply.code(400).send({ error: 'Criteria has no summary' });
    const cached = await getRows(db, id, imp.columns);
    const ctx = evalCtx(cached.types, body.params);
    const errors = validateCriteria(body.criteria, ctx);
    if (Object.keys(errors).length) return reply.code(400).send({ error: 'Criteria has errors', errors });

    const { groupBy } = body.criteria.summary;
    const detailFields = body.criteria.summary.detailFields ?? [];
    const wanted = groupKeyFromValues(body.groupValues, groupBy, cached.types);
    const compiled = compileCriteria(body.criteria, ctx);
    const indices: number[] = [];
    for (let i = 0; i < cached.typed.length; i++) {
      if (compiled.matches(cached.typed[i]) && groupKey(cached.raw[i], cached.typed[i], groupBy, cached.types) === wanted) indices.push(i);
    }
    const fields = detailFields.length ? detailFields : imp.columns.map((c) => c.name).filter((n) => !groupBy.includes(n));
    const columns = imp.columns.filter((c) => fields.includes(c.name));
    const subTypes = Object.fromEntries(columns.map((c) => [c.name, c.type]));
    return {
      columns,
      rows: indices.slice(0, body.limit).map((i) => ({ index: i, data: cached.raw[i] })),
      matched: indices.length,
      subtotals: columnTotals(cached.typed, indices, subTypes),
    };
  });

  // -- Explain one row -------------------------------------------------------
  const explainSchema = z.object({ criteria: criteriaSchema, params: z.record(z.string()).optional(), rowIndex: z.number().int().min(0) });
  app.post('/api/imports/:id/explain', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = explainSchema.parse(req.body);
    const [imp] = await db.select().from(imports).where(eq(imports.id, id));
    if (!imp) return reply.code(404).send({ error: 'Import not found' });
    const cached = await getRows(db, id, imp.columns);
    const row = cached.typed[body.rowIndex];
    if (!row) return reply.code(404).send({ error: 'Row not found' });
    const ctx = evalCtx(cached.types, body.params);
    const errors = validateCriteria(body.criteria, ctx);
    if (Object.keys(errors).length) return reply.code(400).send({ error: 'Criteria has errors', errors });
    return compileCriteria(body.criteria, ctx).explain(row);
  });

  // -- Export ----------------------------------------------------------------
  const exportSchema = z.object({
    criteria: criteriaSchema.optional(),
    params: z.record(z.string()).optional(),
    mode: z.enum(['detail', 'summary']).default('detail'),
    format: z.enum(['csv', 'xlsx']).default('csv'),
  });
  app.post('/api/imports/:id/export', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = exportSchema.parse(req.body ?? {});
    const [imp] = await db.select().from(imports).where(eq(imports.id, id));
    if (!imp) return reply.code(404).send({ error: 'Import not found' });
    const cached = await getRows(db, id, imp.columns);
    let indices = cached.raw.map((_, i) => i);
    let columns = imp.columns;
    let rows = cached.raw;
    let suffix = '';
    if (body.criteria) {
      const ctx = evalCtx(cached.types, body.params);
      const errors = { ...validateCriteria(body.criteria, ctx), ...havingErrors(body.criteria, cached.types, ctx) };
      if (Object.keys(errors).length) return reply.code(400).send({ error: 'Criteria has errors', errors });
      const compiled = compileCriteria(body.criteria, ctx);
      indices = indices.filter((i) => compiled.matches(cached.typed[i]));
      rows = indices.map((i) => cached.raw[i]);
      if (body.mode === 'summary' && isSummaryActive(body.criteria.summary)) {
        const s = summarize(cached.raw, cached.typed, indices, body.criteria.summary, ctx);
        columns = s.columns;
        rows = s.raw;
        suffix = '-summary';
      }
    }
    const base = imp.name.replace(/[^\w.-]+/g, '_') + suffix;
    if (body.format === 'xlsx') {
      return reply
        .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header('Content-Disposition', `attachment; filename="${base}.xlsx"`)
        .send(toXlsx(columns, rows));
    }
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${base}.csv"`)
      .send(toCsv(columns, rows));
  });
}
