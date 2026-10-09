// Commission runs: read an import's deals, pay each person on each deal
// under the plan in force that day, split deals that cross a tier, and keep
// the lines so statements, holds and accounting can build on them.
//
// Each line is then either paid on the next payroll or put on hold with a
// reason (by a hold rule at run time, or by hand), and a held line can be
// released, after which it pays like a deal that closed on the release date.
import {
  DEFAULT_HOLD_REASONS,
  LINE_STATUSES,
  applyHoldRules,
  computeCommissionLines,
  formatDateMs,
  holdRuleSchema,
  makeDatedPlanLookup,
  payMonthFor,
  type DealInput,
} from '@commissions/shared';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import type { Db } from '../db/client.js';
import { auditLog, commissionLines, commissionRuns, holdReasons, imports, type CommissionRunConfig } from '../db/schema.js';
import { toCsv } from '../export.js';
import { getRows } from '../rowcache.js';
import { loadEmployeeRecords } from './plans.js';

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const today = () => new Date().toISOString().slice(0, 10);

const runSchema = z.object({
  name: z.string().min(1),
  importId: z.string().uuid(),
  repField: z.string().min(1),
  payees: z.array(z.object({ role: z.string().min(1), field: z.string().min(1) })).default([]),
  amountField: z.string().min(1),
  dateField: z.string().nullable().optional(),
  dealKeyField: z.string().nullable().optional(),
  from: dateStr.nullable().optional(),
  to: dateStr.nullable().optional(),
  holdRules: z.array(holdRuleSchema).default([]),
  payLagMonths: z.number().int().min(0).max(12).default(1),
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
  'Pay Month',
  'Hold Reason',
  'Hold Note',
  'Held At',
  'Released At',
];

/** Make sure the default hold reasons exist (idempotent). */
export async function seedHoldReasons(db: Db) {
  const existing = new Set((await db.select({ key: holdReasons.key }).from(holdReasons)).map((r) => r.key));
  const missing = DEFAULT_HOLD_REASONS.map((r, i) => ({ ...r, builtin: 1, sortOrder: i })).filter((r) => !existing.has(r.key));
  if (missing.length) await db.insert(holdReasons).values(missing);
}

export async function commissionRoutes(app: FastifyInstance, db: Db) {
  await seedHoldReasons(db);

  // -- Hold reasons ----------------------------------------------------------
  app.get('/api/hold-reasons', async () => db.select().from(holdReasons).orderBy(asc(holdReasons.sortOrder), asc(holdReasons.name)));

  app.post('/api/hold-reasons', async (req, reply) => {
    const body = z.object({ name: z.string().min(1) }).parse(req.body);
    const key = body.name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    if (!key) return reply.code(400).send({ error: 'Name must contain letters or digits' });
    const [dupe] = await db.select({ id: holdReasons.id }).from(holdReasons).where(eq(holdReasons.key, key));
    if (dupe) return reply.code(409).send({ error: `A hold reason "${body.name}" already exists` });
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(holdReasons);
    const [row] = await db.insert(holdReasons).values({ key, name: body.name.trim(), sortOrder: n }).returning();
    await db.insert(auditLog).values({ action: 'hold_reason.create', entityType: 'hold_reason', entityId: row.id });
    return row;
  });

  app.delete('/api/hold-reasons/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [row] = await db.select().from(holdReasons).where(eq(holdReasons.id, id));
    if (!row) return reply.code(404).send({ error: 'Not found' });
    if (row.builtin) return reply.code(400).send({ error: 'Built-in hold reasons cannot be deleted' });
    await db.delete(holdReasons).where(eq(holdReasons.id, id));
    return reply.code(204).send();
  });

  // -- Runs ------------------------------------------------------------------
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
    const knownReasons = new Set((await db.select({ key: holdReasons.key }).from(holdReasons)).map((r) => r.key));
    const badReason = body.holdRules.find((r) => !knownReasons.has(r.reasonKey));
    if (badReason) return reply.code(400).send({ error: `Unknown hold reason "${badReason.reasonKey}"` });

    const config_: CommissionRunConfig = {
      repField: body.repField,
      payees: body.payees,
      amountField: body.amountField,
      dateField: body.dateField ?? null,
      dealKeyField: body.dealKeyField ?? null,
      from: body.from ?? null,
      to: body.to ?? null,
      holdRules: body.holdRules,
      payLagMonths: body.payLagMonths,
    };

    const holds = applyHoldRules(cached.typed, body.holdRules, { types: cached.types, fiscalYearStartMonth: config.fiscalYearStartMonth, weekStartsOn: config.weekStartsOn });
    const ruleErrors = Object.entries(holds.errors);
    if (ruleErrors.length) return reply.code(400).send({ error: `Hold rule problem: ${ruleErrors.map(([, m]) => m).join('; ')}` });

    const deals: DealInput[] = [];
    cached.typed.forEach((row, i) => {
      const rawRow = cached.raw[i];
      const dateMs = config_.dateField ? row[config_.dateField] : null;
      const date = typeof dateMs === 'number' ? formatDateMs(dateMs, 'date') : null;
      if (config_.from && date !== null && date < config_.from) return;
      if (config_.to && date !== null && date > config_.to) return;
      // Date-bounded runs skip undated rows: they can't be placed in the window.
      if ((config_.from || config_.to) && date === null) return;
      const amount = row[config_.amountField];
      const payees = [{ role: 'Rep', field: config_.repField }, ...config_.payees]
        .map((p) => ({ role: p.role, name: String(rawRow[p.field] ?? '').trim() }))
        .filter((p) => p.name);
      if (!payees.length) return;
      deals.push({
        rowIndex: i,
        dealKey: config_.dealKeyField ? String(rawRow[config_.dealKeyField] ?? '').trim() || null : null,
        date,
        amount: typeof amount === 'number' ? amount : null,
        payees,
      });
    });

    const lookup = makeDatedPlanLookup(await loadEmployeeRecords(db));
    const result = computeCommissionLines(deals, lookup, { defaultAsOf: config_.to ?? undefined });
    const runDate = today();

    const [run] = await db
      .insert(commissionRuns)
      .values({
        name: body.name.trim(),
        importId: imp.id,
        importName: imp.name,
        config: config_,
        dealCount: result.dealCount,
        lineCount: result.lines.length,
        totalPayout: result.totalPayout,
        warnings: result.warnings,
      })
      .returning();
    const BATCH = 1000;
    for (let i = 0; i < result.lines.length; i += BATCH) {
      await db.insert(commissionLines).values(
        result.lines.slice(i, i + BATCH).map((l) => {
          const reason = holds.reasons[l.rowIndex];
          return {
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
            status: reason ? 'hold' : 'pay',
            holdReason: reason,
            heldAt: reason ? (l.dealDate ?? runDate) : null,
            payMonth: reason ? null : payMonthFor(l.dealDate, body.payLagMonths),
          };
        }),
      );
    }
    await db.insert(auditLog).values({
      action: 'commission_run.create',
      entityType: 'commission_run',
      entityId: run.id,
      detail: { deals: result.dealCount, lines: result.lines.length, held: holds.reasons.filter(Boolean).length },
    });
    return { ...run, totals: result.totals };
  });

  app.delete('/api/commission-runs/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await db.delete(commissionRuns).where(eq(commissionRuns.id, id));
    await db.insert(auditLog).values({ action: 'commission_run.delete', entityType: 'commission_run', entityId: id });
    return reply.code(204).send();
  });

  // -- Pay / hold / release --------------------------------------------------
  const linesOf = async (runId: string, ids: number[]) =>
    ids.length ? db.select().from(commissionLines).where(and(eq(commissionLines.runId, runId), inArray(commissionLines.id, ids))) : [];

  const holdSchema = z.object({ lineIds: z.array(z.number().int()).min(1), reasonKey: z.string().min(1), note: z.string().nullable().optional(), heldAt: dateStr.optional() });
  /** Put lines on hold (from pay or released). */
  app.post('/api/commission-runs/:id/hold', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = holdSchema.parse(req.body);
    const [reason] = await db.select().from(holdReasons).where(eq(holdReasons.key, body.reasonKey));
    if (!reason) return reply.code(400).send({ error: `Unknown hold reason "${body.reasonKey}"` });
    const rows = await linesOf(id, body.lineIds);
    if (rows.length !== body.lineIds.length) return reply.code(404).send({ error: 'Some lines were not found in this run' });
    await db
      .update(commissionLines)
      .set({ status: 'hold', holdReason: body.reasonKey, holdNote: body.note?.trim() || null, heldAt: body.heldAt ?? today(), releasedAt: null, payMonth: null })
      .where(and(eq(commissionLines.runId, id), inArray(commissionLines.id, body.lineIds)));
    await db.insert(auditLog).values({ action: 'commission_line.hold', entityType: 'commission_run', entityId: id, detail: { lineIds: body.lineIds, reason: body.reasonKey, note: body.note ?? null } });
    return linesOf(id, body.lineIds);
  });

  const releaseSchema = z.object({ lineIds: z.array(z.number().int()).min(1), releasedAt: dateStr.optional(), note: z.string().nullable().optional() });
  /** Take lines off hold: they pay on the payroll after the release date, like a fresh close. */
  app.post('/api/commission-runs/:id/release', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = releaseSchema.parse(req.body);
    const [run] = await db.select().from(commissionRuns).where(eq(commissionRuns.id, id));
    if (!run) return reply.code(404).send({ error: 'Run not found' });
    const rows = await linesOf(id, body.lineIds);
    const notHeld = rows.filter((r) => r.status !== 'hold');
    if (notHeld.length) return reply.code(400).send({ error: `${notHeld.length} line(s) are not on hold` });
    if (rows.length !== body.lineIds.length) return reply.code(404).send({ error: 'Some lines were not found in this run' });
    const releasedAt = body.releasedAt ?? today();
    await db
      .update(commissionLines)
      .set({ status: 'released', releasedAt, payMonth: payMonthFor(releasedAt, run.config.payLagMonths ?? 1), ...(body.note !== undefined ? { holdNote: body.note?.trim() || null } : {}) })
      .where(and(eq(commissionLines.runId, id), inArray(commissionLines.id, body.lineIds)));
    await db.insert(auditLog).values({ action: 'commission_line.release', entityType: 'commission_run', entityId: id, detail: { lineIds: body.lineIds, releasedAt } });
    return linesOf(id, body.lineIds);
  });

  const paySchema = z.object({ lineIds: z.array(z.number().int()).min(1) });
  /** Undo a hold: back to paying on the payroll after the close date. */
  app.post('/api/commission-runs/:id/pay', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = paySchema.parse(req.body);
    const [run] = await db.select().from(commissionRuns).where(eq(commissionRuns.id, id));
    if (!run) return reply.code(404).send({ error: 'Run not found' });
    const rows = await linesOf(id, body.lineIds);
    if (rows.length !== body.lineIds.length) return reply.code(404).send({ error: 'Some lines were not found in this run' });
    for (const r of rows) {
      await db
        .update(commissionLines)
        .set({ status: 'pay', holdReason: null, holdNote: null, heldAt: null, releasedAt: null, payMonth: payMonthFor(r.dealDate, run.config.payLagMonths ?? 1) })
        .where(eq(commissionLines.id, r.id));
    }
    await db.insert(auditLog).values({ action: 'commission_line.pay', entityType: 'commission_run', entityId: id, detail: { lineIds: body.lineIds } });
    return linesOf(id, body.lineIds);
  });

  // -- Export ----------------------------------------------------------------
  app.get('/api/commission-runs/:id/export', async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = z.object({ status: z.enum(LINE_STATUSES).optional() }).parse(req.query ?? {});
    const [run] = await db.select().from(commissionRuns).where(eq(commissionRuns.id, id));
    if (!run) return reply.code(404).send({ error: 'Run not found' });
    const reasonNames = new Map((await db.select().from(holdReasons)).map((r) => [r.key, r.name]));
    const lines = (await db.select().from(commissionLines).where(eq(commissionLines.runId, id)).orderBy(asc(commissionLines.id))).filter((l) => !q.status || l.status === q.status);
    const num = (n: number | null) => (n === null ? '' : String(n));
    const rows = lines.map((l) => ({
      Deal: l.dealKey ?? `row ${l.rowIndex + 1}`,
      'Close Date': l.dealDate ?? '',
      'Deal Amount': num(l.dealAmount),
      Payee: l.payee,
      Role: l.role,
      Plan: l.planName ?? '',
      Method: l.method,
      'Tier From': num(l.tierFrom),
      'Tier To': num(l.tierTo),
      Amount: num(l.amount),
      Rate: num(l.rate),
      Payout: num(l.payout),
      'Attainment Before': String(l.cumulativeBefore),
      'Attainment After': String(l.cumulativeAfter),
      Split: l.split ? 'Y' : '',
      Note: l.note ?? '',
      Status: l.status,
      'Pay Month': l.payMonth ?? '',
      'Hold Reason': l.holdReason ? (reasonNames.get(l.holdReason) ?? l.holdReason) : '',
      'Hold Note': l.holdNote ?? '',
      'Held At': l.heldAt ?? '',
      'Released At': l.releasedAt ?? '',
    }));
    const safe = run.name.replace(/[^\w.-]+/g, '_');
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${safe}-${q.status ?? 'commission'}-lines.csv"`)
      .send(toCsv(LINE_COLUMNS.map((name, index) => ({ name, index, type: 'text' as const, inferredType: 'text' as const })), rows));
  });
}
