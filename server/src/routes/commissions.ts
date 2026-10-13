// Commission runs: read an import's deals, pay each person on each deal
// under the plan in force that day, split deals that cross a tier, and keep
// the lines so statements, holds and accounting can build on them.
//
// Each line is then either paid on the next payroll or put on hold with a
// reason (by a hold rule at run time, or by hand), and a held line can be
// released, after which it pays like a deal that closed on the release date.
import {
  DEFAULT_HOLD_REASONS,
  compileCriteria,
  criteriaSchema,
  payrollTemplateDefinitionSchema,
  periodFromCriteria,
  templateDeals,
  templateFields,
  templateProblems,
  validateCriteria,
  type CommissionLine,
  type TemplateApplyInput,
  LINE_STATUSES,
  applyHoldRules,
  applyPayoutRules,
  buildSubledger,
  componentKey,
  computeCommissionLines,
  formatDateMs,
  holdRuleSchema,
  makeDatedPlanLookup,
  payMonthFor,
  payeeTotals,
  payoutRuleLabel,
  resolveLine,
  roundCents,
  scheduleFor,
  type AccountingLineInput,
  type AccountingPolicy,
} from '@commissions/shared';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { calendar, getAppSettings } from '../appSettings.js';
import type { Db } from '../db/client.js';
import { accountingPeriods, accountingPolicy, auditLog, commissionLines, commissionRuns, employeeTypes, employees, holdReasons, imports, payrollTemplates, type CommissionRunConfig } from '../db/schema.js';
import { toCsv } from '../export.js';
import { getRows } from '../rowcache.js';
import { loadMethodsAndTypes, loadSettings, payeeAccounting } from './accounting.js';
import { loadEmployeeRecords } from './plans.js';
import { evalContext, loadPayoutRules } from './payoutRules.js';
import { programLinesForRun } from './programs.js';

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const today = () => new Date().toISOString().slice(0, 10);

const runSchema = z.object({
  name: z.string().min(1),
  importId: z.string().uuid(),
  /** Payroll templates to apply, one per employee type being paid. */
  templateIds: z.array(z.string().uuid()).min(1, 'Pick at least one payroll template'),
  /** The Commission Payroll screen's filters (period, column filters); only matching rows are paid. */
  criteria: criteriaSchema.optional(),
  params: z.record(z.string()).optional(),
  /** Inclusive close-date bounds; default to the criteria's period filter. */
  from: dateStr.nullable().optional(),
  to: dateStr.nullable().optional(),
  payLagMonths: z.number().int().min(0).max(12).default(1),
  includePrograms: z.boolean().default(true),
});

const LINE_COLUMNS = [
  'Deal',
  'Close Date',
  'Deal Amount',
  'Payee',
  'Role',
  'Plan',
  'Component',
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

  /**
   * Calculate and store a run: apply each payroll template to the import's
   * rows (those passing the screen's filters), one line per person per deal.
   * Deals are read from the import as it is right now.
   */
  app.post('/api/commission-runs', async (req, reply) => {
    const body = runSchema.parse(req.body);
    const [imp] = await db.select().from(imports).where(eq(imports.id, body.importId));
    if (!imp) return reply.code(404).send({ error: 'Import not found' });
    const cached = await getRows(db, imp);

    // In the order picked, so a run's lines read the way its templates are listed.
    const order = new Map(body.templateIds.map((id, i) => [id, i]));
    const templateRows = (await db.select().from(payrollTemplates).where(inArray(payrollTemplates.id, body.templateIds))).sort((a, b) => order.get(a.id)! - order.get(b.id)!);
    if (templateRows.length !== new Set(body.templateIds).size) return reply.code(404).send({ error: 'A payroll template was not found; it may have been deleted.' });
    const typeNames = new Map((await db.select({ id: employeeTypes.id, name: employeeTypes.name }).from(employeeTypes)).map((t) => [t.id, t.name]));
    const knownReasons = new Set((await db.select({ key: holdReasons.key }).from(holdReasons)).map((r) => r.key));
    const templates: TemplateApplyInput[] = [];
    for (const t of templateRows) {
      const parsed = payrollTemplateDefinitionSchema.safeParse(t.definition);
      if (!parsed.success) return reply.code(400).send({ error: `${t.name}: its settings could not be read; open the template and save it again.` });
      const def = parsed.data;
      const problems = templateProblems(def, t.employeeTypeId);
      if (problems.length) return reply.code(400).send({ error: `${t.name}: ${problems.join(' ')}` });
      const missing = templateFields(def).filter((f) => !(f in cached.types));
      if (missing.length) return reply.code(400).send({ error: `${t.name}: this import has no column ${missing.map((m) => `"${m}"`).join(', ')}` });
      const badReason = def.holdRules.find((r) => !knownReasons.has(r.reasonKey));
      if (badReason) return reply.code(400).send({ error: `${t.name}: unknown hold reason "${badReason.reasonKey}"` });
      const keys = new Set<string>();
      for (const c of def.components) {
        const key = componentKey(c.name);
        if (!key) return reply.code(400).send({ error: `${t.name}: component name "${c.name}" has no letters or digits` });
        if (keys.has(key)) return reply.code(400).send({ error: `${t.name}: components "${c.name}" and another map to the same key "${key}"; give them distinct names` });
        keys.add(key);
      }
      templates.push({ name: t.name, employeeTypeId: t.employeeTypeId, role: (t.employeeTypeId && typeNames.get(t.employeeTypeId)) || t.name, definition: def });
    }

    const ctx = { types: cached.types, ...evalContext() };
    // The rows the screen's filters let through.
    let indices = cached.typed.map((_, i) => i);
    if (body.criteria) {
      const fctx = { ...ctx, params: body.params };
      const errors = Object.values(validateCriteria(body.criteria, fctx));
      if (errors.length) return reply.code(400).send({ error: `Filter problem: ${errors.join('; ')}` });
      const compiled = compileCriteria(body.criteria, fctx);
      indices = indices.filter((i) => compiled.matches(cached.typed[i]));
    }
    const period = body.criteria ? periodFromCriteria(body.criteria, ctx) : null;
    const from = body.from !== undefined ? body.from : (period?.from ?? null);
    const to = body.to !== undefined ? body.to : (period?.to ?? null);

    // Workspace payout rules go first (they are policy), then each template's own hold rules.
    const payoutRules_ = await loadPayoutRules(db);
    const flagged = applyPayoutRules(cached.typed, payoutRules_, ctx);
    const flagErrors = Object.entries(flagged.errors);
    if (flagErrors.length) {
      // Rules are shared across imports, so say which one failed here (a column may have another type in this file).
      const label = (id: string) => {
        const r = payoutRules_.find((x) => x.id === id);
        return r ? payoutRuleLabel(r) : id;
      };
      return reply.code(400).send({ error: `Payout rule problem: ${flagErrors.map(([id, m]) => `"${label(id)}": ${m}`).join('; ')}` });
    }
    const runWarnings: string[] = [];
    if (flagged.skipped.length) {
      const names = flagged.skipped.flatMap((id) => {
        const r = payoutRules_.find((x) => x.id === id);
        return r ? [...r.filters, ...r.requirements].map((c) => c.field).filter((f) => !(f in cached.types)) : [id];
      });
      runWarnings.push(`${flagged.skipped.length} payout rule${flagged.skipped.length === 1 ? '' : 's'} skipped: this import has no column ${[...new Set(names)].map((n) => `"${n}"`).join(', ')}.`);
    }

    const staff = await db.select({ name: employees.name, employeeTypeId: employees.employeeTypeId, startDate: employees.startDate, status: employees.status, statusDate: employees.statusDate }).from(employees);
    const lookup = makeDatedPlanLookup(await loadEmployeeRecords(db));
    const asOf = to ?? today();
    // Each template pays its own lines; attainment accrues within the template's deals.
    const lines: CommissionLine[] = [];
    const lineHold: (string | null)[] = [];
    const lineContract: ({ start: string | null; term: number | null } | undefined)[] = [];
    const dealRows = new Set<number>();
    const warnings: string[] = [];
    for (const t of templates) {
      const td = templateDeals({ raw: cached.raw, typed: cached.typed, indices }, t, staff, { from, to, asOf });
      const holds = applyHoldRules(cached.typed, t.definition.holdRules, ctx);
      const ruleErrors = Object.values(holds.errors);
      if (ruleErrors.length) return reply.code(400).send({ error: `${t.name}: hold rule problem: ${ruleErrors.join('; ')}` });
      const res = computeCommissionLines(td.deals, lookup, { defaultAsOf: to ?? undefined });
      for (const d of td.deals) dealRows.add(d.rowIndex);
      for (const l of res.lines) {
        lines.push(l);
        lineHold.push(holds.reasons[l.rowIndex] ?? null);
        lineContract.push(td.contract.get(l.rowIndex));
      }
      warnings.push(...td.warnings, ...res.warnings);
    }
    // Spiffs, accelerators and bonuses pay alongside the plan, each from its own import.
    if (body.includePrograms) {
      const programs = await programLinesForRun(db, { from, to });
      for (const l of programs.lines) {
        lines.push(l);
        lineHold.push(null);
        lineContract.push(undefined);
      }
      warnings.push(...programs.warnings);
    }
    const totals = payeeTotals(lines);
    const totalPayout = roundCents(lines.reduce((a, l) => a + (l.payout ?? 0), 0));

    const first = templates[0].definition;
    const config_: CommissionRunConfig = {
      repField: first.crediting === 'own' ? first.creditField : '',
      payees: [],
      amountField: first.amountField,
      dateField: first.dateField || null,
      dealKeyField: first.dealKeyField || null,
      from,
      to,
      holdRules: templates.flatMap((t) => t.definition.holdRules),
      payLagMonths: body.payLagMonths,
      contractStartField: first.contractStartField || null,
      termMonthsField: first.termMonthsField || null,
      contractEndField: first.contractEndField || null,
      components: first.components,
      marginField: first.marginField || null,
      includePrograms: body.includePrograms,
      templates: templateRows.map((r, i) => ({ id: r.id, name: r.name, role: templates[i].role })),
      filtered: !!body.criteria,
    };
    const runDate = today();

    const [run] = await db
      .insert(commissionRuns)
      .values({
        name: body.name.trim(),
        importId: imp.id,
        importName: imp.name,
        config: config_,
        dealCount: dealRows.size,
        lineCount: lines.length,
        totalPayout,
        warnings: [...new Set([...warnings, ...runWarnings])],
      })
      .returning();
    const BATCH = 1000;
    for (let i = 0; i < lines.length; i += BATCH) {
      await db.insert(commissionLines).values(
        lines.slice(i, i + BATCH).map((l, j) => {
          const flag = flagged.hits[l.rowIndex];
          const reason = flag?.reasonKey ?? lineHold[i + j];
          const contract = lineContract[i + j];
          return {
            runId: run.id,
            rowIndex: l.rowIndex,
            dealKey: l.dealKey,
            dealDate: l.dealDate,
            dealAmount: l.dealAmount,
            payee: l.payee,
            role: l.role,
            planName: l.planName,
            component: l.component,
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
            holdNote: flag ? flag.message || flag.ruleName : null,
            heldAt: reason ? (l.dealDate ?? runDate) : null,
            payMonth: reason ? null : payMonthFor(l.dealDate, body.payLagMonths),
            contractStart: contract?.start ?? null,
            termMonths: contract?.term ?? null,
          };
        }),
      );
    }
    await db.insert(auditLog).values({
      action: 'commission_run.create',
      entityType: 'commission_run',
      entityId: run.id,
      detail: { deals: dealRows.size, lines: lines.length, templates: config_.templates?.map((t) => t.name), held: lines.filter((_, k) => flagged.hits[lines[k].rowIndex] || lineHold[k]).length, flaggedByPayoutRules: flagged.hits.filter(Boolean).length },
    });
    return { ...run, totals };
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
    const payMonth = payMonthFor(releasedAt, run.config.payLagMonths ?? 1);
    if (payMonth && !getAppSettings().general.allowReleaseIntoClosedMonth) {
      const [closed] = await db.select({ month: accountingPeriods.month }).from(accountingPeriods).where(eq(accountingPeriods.month, payMonth));
      if (closed) return reply.code(400).send({ error: `A release dated ${releasedAt} would pay in ${payMonth}, which is closed. Pick a later release date, or allow it under Setup › General › Period controls.` });
    }
    await db
      .update(commissionLines)
      .set({ status: 'released', releasedAt, payMonth, ...(body.note !== undefined ? { holdNote: body.note?.trim() || null } : {}) })
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

  // -- Accounting ------------------------------------------------------------
  const policySchema = z.object({
    method: z.enum(['contract_term', 'customer_life']),
    customerLifeMonths: z.number().int().min(1).max(240),
    defaultTermMonths: z.number().int().min(1).max(240),
  });
  const getPolicy = async (): Promise<AccountingPolicy & { id: string }> => {
    const [row] = await db.select().from(accountingPolicy).limit(1);
    if (row) return row;
    const [created] = await db.insert(accountingPolicy).values({}).returning();
    return created;
  };
  app.get('/api/accounting-policy', async () => getPolicy());
  app.put('/api/accounting-policy', async (req) => {
    const body = policySchema.parse(req.body);
    const cur = await getPolicy();
    const [row] = await db.update(accountingPolicy).set({ ...body, updatedAt: new Date() }).where(eq(accountingPolicy.id, cur.id)).returning();
    await db.insert(auditLog).values({ action: 'accounting_policy.update', entityType: 'accounting_policy', entityId: cur.id, detail: body });
    return row;
  });

  /**
   * The run's subledger. Each payee's employee type picks an amortization
   * type (treatment + method); payees without one fall back to the type's
   * own treatment and the company default method.
   */
  const subledgerFor = async (runId: string) => {
    const lines = await db.select().from(commissionLines).where(eq(commissionLines.runId, runId)).orderBy(asc(commissionLines.id));
    const byName = await payeeAccounting(db);
    const typeIdOf = new Map<number, string | null>();
    const input: AccountingLineInput[] = lines.map((l) => {
      const e = byName.get(l.payee.trim().toLowerCase());
      typeIdOf.set(l.id, e?.typeId ?? null);
      return {
        lineId: l.id,
        dealKey: l.dealKey,
        payee: l.payee,
        role: l.role,
        department: e?.dept ?? 'Unassigned',
        treatment: e?.treatment ?? 'capitalize',
        payout: l.payout,
        status: l.status,
        payMonth: l.payMonth,
        contractStart: l.contractStart,
        termMonths: l.termMonths,
      };
    });
    const policy = await getPolicy();
    const settings = await loadSettings(db);
    const { methods, types } = await loadMethodsAndTypes(db);
    const result = buildSubledger(input, { method: policy.method, customerLifeMonths: policy.customerLifeMonths, defaultTermMonths: policy.defaultTermMonths }, (l) => {
      const r = resolveLine({ amortizationTypeId: typeIdOf.get(l.lineId) ?? null, fallbackTreatment: l.treatment }, settings, methods, types);
      if (r.treatment === 'expense' || !r.method || !l.payMonth || l.payout === null) return { treatment: 'expense', schedule: null };
      const s = scheduleFor(l.payout, r.method.def, { payMonth: l.payMonth, contractStart: l.contractStart, termMonths: l.termMonths, defaultTermMonths: settings.defaultTermMonths }, settings.practicalExpedient);
      const warnings: string[] = [];
      if (s.warnings.includes('no_start')) warnings.push('Some capitalized lines have no subscription start date; amortization starts in their pay month.');
      if (s.warnings.includes('no_term')) warnings.push(`Some capitalized lines have no contract term; the default of ${settings.defaultTermMonths} months was used.`);
      if (!s.capitalize) return { treatment: 'expense', schedule: null, warnings };
      return { treatment: 'capitalize', schedule: s, warnings };
    });
    const untyped = new Set(input.filter((i) => i.department === 'Unassigned' && i.status !== 'hold' && i.payout !== null).map((i) => i.payee));
    if (untyped.size) result.warnings.push(`${[...untyped].join(', ')} ${untyped.size === 1 ? 'has' : 'have'} no employee type, so their commissions were capitalized under "Unassigned".`);
    return result;
  };

  app.get('/api/commission-runs/:id/accounting', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [run] = await db.select({ id: commissionRuns.id }).from(commissionRuns).where(eq(commissionRuns.id, id));
    if (!run) return reply.code(404).send({ error: 'Run not found' });
    const res = await subledgerFor(id);
    // The schedule's per-month map is large; the UI gets a compact version and exports the long form.
    return { ...res, schedule: res.schedule.map(({ byMonth: _b, ...s }) => s) };
  });

  const csvCols = (names: string[]) => names.map((name, index) => ({ name, index, type: 'text' as const, inferredType: 'text' as const }));
  app.get('/api/commission-runs/:id/accounting/schedule.csv', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [run] = await db.select().from(commissionRuns).where(eq(commissionRuns.id, id));
    if (!run) return reply.code(404).send({ error: 'Run not found' });
    const res = await subledgerFor(id);
    const months = [...new Set(res.schedule.flatMap((s) => Object.keys(s.byMonth)))].sort();
    const cols = ['Line', 'Deal', 'Payee', 'Department', 'Capitalized Month', 'Amount', 'Start', 'End', 'Months', ...months];
    const rows = res.schedule.map((s) => ({
      Line: String(s.lineId),
      Deal: s.dealKey ?? '',
      Payee: s.payee,
      Department: s.department,
      'Capitalized Month': s.capitalizedMonth,
      Amount: String(s.amount),
      Start: s.startMonth,
      End: s.endMonth,
      Months: String(s.months),
      ...Object.fromEntries(months.map((m) => [m, s.byMonth[m] === undefined ? '' : String(s.byMonth[m])])),
    }));
    const safe = run.name.replace(/[^\w.-]+/g, '_');
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${safe}-amortization-schedule.csv"`)
      .send(toCsv(csvCols(cols), rows));
  });

  app.get('/api/commission-runs/:id/accounting/entries.csv', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [run] = await db.select().from(commissionRuns).where(eq(commissionRuns.id, id));
    if (!run) return reply.code(404).send({ error: 'Run not found' });
    const res = await subledgerFor(id);
    const cols = ['Month', 'Memo', 'Account', 'Department', 'Debit', 'Credit'];
    const rows = res.entries.flatMap((e) =>
      e.lines.map((l) => ({ Month: e.month, Memo: e.memo, Account: l.account, Department: l.department ?? '', Debit: l.debit ? String(l.debit) : '', Credit: l.credit ? String(l.credit) : '' })),
    );
    const safe = run.name.replace(/[^\w.-]+/g, '_');
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${safe}-journal-entries.csv"`)
      .send(toCsv(csvCols(cols), rows));
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
      Deal: l.dealKey ?? (l.rowIndex < 0 ? (l.planName ?? '') : `row ${l.rowIndex + 1}`),
      'Close Date': l.dealDate ?? '',
      'Deal Amount': num(l.dealAmount),
      Payee: l.payee,
      Role: l.role,
      Plan: l.planName ?? '',
      Component: l.component ?? '',
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
