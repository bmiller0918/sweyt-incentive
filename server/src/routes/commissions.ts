// Commission runs: read an import's deals, pay each person on each deal
// under the plan in force that day, split deals that cross a tier, and keep
// the lines so statements, holds and accounting can build on them.
import { computeCommissionLines, formatDateMs, makeDatedPlanLookup, type DealInput } from '@commissions/shared';
import { asc, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { auditLog, commissionLines, commissionRuns, imports, type CommissionRunConfig } from '../db/schema.js';
import { toCsv } from '../export.js';
import { getRows } from '../rowcache.js';
import { loadEmployeeRecords } from './plans.js';

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional();

const runSchema = z.object({
  name: z.string().min(1),
  importId: z.string().uuid(),
  repField: z.string().min(1),
  payees: z.array(z.object({ role: z.string().min(1), field: z.string().min(1) })).default([]),
  amountField: z.string().min(1),
  dateField: z.string().nullable().optional(),
  dealKeyField: z.string().nullable().optional(),
  from: dateStr,
  to: dateStr,
});

const LINE_COLUMNS = [
  'Deal',
  'Close Date',
  'Deal Amount',
  'Payee',
  'Role',
  'Plan',
  'Method',
  'Tier From',
  'Tier To',
  'Amount',
  'Rate',
  'Payout',
  'Attainment Before',
  'Attainment After',
  'Split',
  'Note',
  'Status',
];

export async function commissionRoutes(app: FastifyInstance, db: Db) {
  app.get('/api/commission-runs', async () => db.select().from(commissionRuns).orderBy(desc(commissionRuns.createdAt)));

  app.get('/api/commission-runs/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [run] = await db.select().from(commissionRuns).where(eq(commissionRuns.id, id));
    if (!run) return reply.code(404).send({ error: 'Run not found' });
    const lines = await db.select().from(commissionLines).where(eq(commissionLines.runId, id)).orderBy(asc(commissionLines.id));
    return { ...run, lines };
  });

  /** Calculate and store a run. Deals are read from the import as it is right now. */
  app.post('/api/commission-runs', async (req, reply) => {
    const body = runSchema.parse(req.body);
    const [imp] = await db.select().from(imports).where(eq(imports.id, body.importId));
    if (!imp) return reply.code(404).send({ error: 'Import not found' });
    const cached = await getRows(db, imp);
    const fields = [body.repField, body.amountField, body.dateField, body.dealKeyField, ...body.payees.map((p) => p.field)].filter((f): f is string => !!f);
    const missing = fields.filter((f) => !(f in cached.types));
    if (missing.length) return reply.code(400).send({ error: `Column not found: ${missing.join(', ')}` });

    const config: CommissionRunConfig = {
      repField: body.repField,
      payees: body.payees,
      amountField: body.amountField,
      dateField: body.dateField ?? null,
      dealKeyField: body.dealKeyField ?? null,
      from: body.from ?? null,
      to: body.to ?? null,
    };

    const deals: DealInput[] = [];
    cached.typed.forEach((row, i) => {
      const rawRow = cached.raw[i];
      const dateMs = config.dateField ? row[config.dateField] : null;
      const date = typeof dateMs === 'number' ? formatDateMs(dateMs, 'date') : null;
      if (config.from && date !== null && date < config.from) return;
      if (config.to && date !== null && date > config.to) return;
      // Date-bounded runs skip undated rows: they can't be placed in the window.
      if ((config.from || config.to) && date === null) return;
      const amount = row[config.amountField];
      const payees = [{ role: 'Rep', field: config.repField }, ...config.payees]
        .map((p) => ({ role: p.role, name: String(rawRow[p.field] ?? '').trim() }))
        .filter((p) => p.name);
      if (!payees.length) return;
      deals.push({
        rowIndex: i,
        dealKey: config.dealKeyField ? String(rawRow[config.dealKeyField] ?? '').trim() || null : null,
        date,
        amount: typeof amount === 'number' ? amount : null,
        payees,
      });
    });

    const lookup = makeDatedPlanLookup(await loadEmployeeRecords(db));
    const result = computeCommissionLines(deals, lookup, { defaultAsOf: config.to ?? undefined });

    const [run] = await db
      .insert(commissionRuns)
      .values({
        name: body.name.trim(),
        importId: imp.id,
        importName: imp.name,
        config,
        dealCount: result.dealCount,
        lineCount: result.lines.length,
        totalPayout: result.totalPayout,
        warnings: result.warnings,
      })
      .returning();
    const BATCH = 1000;
    for (let i = 0; i < result.lines.length; i += BATCH) {
      await db.insert(commissionLines).values(
        result.lines.slice(i, i + BATCH).map((l) => ({
          runId: run.id,
          rowIndex: l.rowIndex,
          dealKey: l.dealKey,
          dealDate: l.dealDate,
          dealAmount: l.dealAmount,
          payee: l.payee,
          role: l.role,
          planName: l.planName,
          method: l.method,
          tierFrom: l.tierFrom,
          tierTo: l.tierTo,
          amount: l.amount,
          rate: l.rate,
          payout: l.payout,
          cumulativeBefore: l.cumulativeBefore,
          cumulativeAfter: l.cumulativeAfter,
          split: l.split ? 1 : 0,
          note: l.note,
        })),
      );
    }
    await db.insert(auditLog).values({ action: 'commission_run.create', entityType: 'commission_run', entityId: run.id, detail: { deals: result.dealCount, lines: result.lines.length } });
    return { ...run, totals: result.totals };
  });

  app.delete('/api/commission-runs/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await db.delete(commissionRuns).where(eq(commissionRuns.id, id));
    await db.insert(auditLog).values({ action: 'commission_run.delete', entityType: 'commission_run', entityId: id });
    return reply.code(204).send();
  });

  app.get('/api/commission-runs/:id/export', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [run] = await db.select().from(commissionRuns).where(eq(commissionRuns.id, id));
    if (!run) return reply.code(404).send({ error: 'Run not found' });
    const lines = await db.select().from(commissionLines).where(eq(commissionLines.runId, id)).orderBy(asc(commissionLines.id));
    const rows = lines.map((l) => ({
      Deal: l.dealKey ?? `row ${l.rowIndex + 1}`,
      'Close Date': l.dealDate ?? '',
      'Deal Amount': l.dealAmount === null ? '' : String(l.dealAmount),
      Payee: l.payee,
      Role: l.role,
      Plan: l.planName ?? '',
      Method: l.method,
      'Tier From': l.tierFrom === null ? '' : String(l.tierFrom),
      'Tier To': l.tierTo === null ? '' : String(l.tierTo),
      Amount: l.amount === null ? '' : String(l.amount),
      Rate: l.rate === null ? '' : String(l.rate),
      Payout: l.payout === null ? '' : String(l.payout),
      'Attainment Before': String(l.cumulativeBefore),
      'Attainment After': String(l.cumulativeAfter),
      Split: l.split ? 'Y' : '',
      Note: l.note ?? '',
      Status: l.status,
    }));
    const safe = run.name.replace(/[^\w.-]+/g, '_');
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${safe}-commission-lines.csv"`)
      .send(toCsv(LINE_COLUMNS.map((name, index) => ({ name, index, type: 'text' as const, inferredType: 'text' as const })), rows));
  });
}
