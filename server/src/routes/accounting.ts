// Accounting: amortization methods and types (settings), the amortization
// register, and the monthly close that books commissions into it and
// produces the month's journals (accrual, amortization, write-offs and the
// current / non-current reclass).
//
// Months are closed in order. A closed month is locked: its journals and the
// assets it created are stored, and later changes to runs only reach the
// books as late lines in the next open month. The latest closed month can be
// reopened, which deletes what it booked.
import {
  BUILTIN_METHODS,
  BUILTIN_TYPES,
  DEFAULT_ACCOUNTS,
  addMonths,
  assetPosition,
  bookedTotals,
  closeMonth,
  entryBalance,
  lineSourceKey,
  registerRollforward,
  scheduleFor,
  suggestTypeKey,
  validateMethod,
  type AccountingSettings,
  type AmortizationMethodDef,
  type AmortizationTypeDef,
  type BookedLine,
  type CloseLineInput,
  type JournalEntry,
  type NamedMethod,
  type RegisterAsset,
} from '@commissions/shared';
import { asc, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import {
  accountingPeriods,
  accountingPolicy,
  amortizationAssets,
  amortizationMethods,
  amortizationTypes,
  auditLog,
  commissionLines,
  commissionRuns,
  employeeTypes,
  employees,
} from '../db/schema.js';
import { toCsv } from '../export.js';

const ym = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const glAccount = z.object({ number: z.string().max(40), name: z.string().min(1).max(200) });
const methodDef = z.object({
  kind: z.enum(['straight_line', 'yearly_percent', 'monthly_percent', 'immediate']),
  periodBasis: z.enum(['contract_term', 'fixed_months']).default('contract_term'),
  months: z.number().int().min(1).max(600).nullable().default(null),
  termMultiplier: z.number().min(0.1).max(20).default(1),
  yearPercents: z.array(z.number().min(0).max(100)).max(20).default([]),
  monthPercents: z.array(z.number().min(0).max(100)).max(240).default([]),
  startBasis: z.enum(['contract_start', 'pay_month', 'month_after_pay']).default('contract_start'),
});
const methodSchema = z.object({ name: z.string().min(1), description: z.string().nullable().optional(), def: methodDef });
const typeSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  treatment: z.enum(['capitalize', 'expense']),
  methodId: z.string().uuid().nullable().optional(),
  expenseAccount: glAccount.nullable().optional(),
  amortizationAccount: glAccount.nullable().optional(),
  employeeTypeIds: z.array(z.string().uuid()).optional(),
});
const settingsSchema = z.object({
  defaultMethodId: z.string().uuid().nullable(),
  defaultTermMonths: z.number().int().min(1).max(240),
  practicalExpedient: z.boolean(),
  reclassEnabled: z.boolean(),
  reclassMode: z.enum(['true_up', 'reverse_rebook']),
  accounts: z.object({
    deferredCurrent: glAccount,
    deferredNoncurrent: glAccount,
    commissionExpense: glAccount,
    amortizationExpense: glAccount,
    impairmentExpense: glAccount,
    accruedCommissions: glAccount,
  }),
});

const actor = (req: FastifyRequest) => (req as FastifyRequest & { user?: { email?: string } | null }).user?.email ?? 'system';
const csvCols = (names: string[]) => names.map((name, index) => ({ name, index, type: 'text' as const, inferredType: 'text' as const }));
const csvReply = (reply: { header: (k: string, v: string) => unknown; send: (b: string) => unknown }, filename: string, cols: string[], rows: Record<string, string>[]) => {
  reply.header('Content-Type', 'text/csv; charset=utf-8');
  reply.header('Content-Disposition', `attachment; filename="${filename}"`);
  return reply.send(toCsv(csvCols(cols), rows));
};
const num = (n: number) => (n ? String(n) : '');

/** Seed the built-in methods and types the first time, and point the policy at a default method. */
export async function seedAccounting(db: Db) {
  const existingMethods = await db.select().from(amortizationMethods);
  let methodRows = existingMethods;
  if (!existingMethods.length) {
    methodRows = await db
      .insert(amortizationMethods)
      .values(BUILTIN_METHODS.map((m) => ({ name: m.name, description: m.description, def: m.def, builtinKey: m.key })))
      .returning();
  }
  const byKey = new Map(methodRows.filter((m) => m.builtinKey).map((m) => [m.builtinKey!, m.id]));
  const [typeCount] = await db.select({ id: amortizationTypes.id }).from(amortizationTypes).limit(1);
  if (!typeCount) {
    await db.insert(amortizationTypes).values(
      BUILTIN_TYPES.map((t, i) => ({
        name: t.name,
        description: t.description,
        treatment: t.treatment,
        methodId: t.methodKey ? (byKey.get(t.methodKey) ?? null) : null,
        builtinKey: t.key,
        sortOrder: i,
      })),
    );
  }
  const [policy] = await db.select().from(accountingPolicy).limit(1);
  const legacyDefault = byKey.get(policy?.method === 'customer_life' ? 'customer_life_48' : 'contract_term') ?? null;
  if (!policy) await db.insert(accountingPolicy).values({ defaultMethodId: legacyDefault });
  else if (!policy.defaultMethodId && !existingMethods.length) await db.update(accountingPolicy).set({ defaultMethodId: legacyDefault }).where(eq(accountingPolicy.id, policy.id));
}

export async function loadSettings(db: Db): Promise<AccountingSettings & { id: string }> {
  let [p] = await db.select().from(accountingPolicy).limit(1);
  if (!p) [p] = await db.insert(accountingPolicy).values({}).returning();
  return {
    id: p.id,
    defaultMethodId: p.defaultMethodId,
    defaultTermMonths: p.defaultTermMonths,
    practicalExpedient: !!p.practicalExpedient,
    reclassEnabled: !!p.reclassEnabled,
    reclassMode: p.reclassMode,
    accounts: { ...DEFAULT_ACCOUNTS, ...(p.accounts ?? {}) },
  };
}

export async function loadMethodsAndTypes(db: Db): Promise<{ methods: NamedMethod[]; types: AmortizationTypeDef[] }> {
  const methods = (await db.select().from(amortizationMethods).orderBy(asc(amortizationMethods.createdAt))).map((m) => ({ id: m.id, name: m.name, def: m.def }));
  const types = (await db.select().from(amortizationTypes).orderBy(asc(amortizationTypes.sortOrder), asc(amortizationTypes.name))).map((t) => ({
    id: t.id,
    name: t.name,
    treatment: t.treatment,
    methodId: t.methodId,
    expenseAccount: t.expenseAccount ?? null,
    amortizationAccount: t.amortizationAccount ?? null,
  }));
  return { methods, types };
}

/** Department, amortization type and fallback treatment per payee, from their employee type. */
export async function payeeAccounting(db: Db) {
  const emps = await db
    .select({ name: employees.name, dept: employeeTypes.name, treatment: employeeTypes.costTreatment, typeId: employeeTypes.amortizationTypeId })
    .from(employees)
    .leftJoin(employeeTypes, eq(employees.employeeTypeId, employeeTypes.id));
  return new Map(emps.map((e) => [e.name.trim().toLowerCase(), e]));
}

const toAsset = (r: typeof amortizationAssets.$inferSelect): RegisterAsset => ({
  id: r.id,
  sourceKey: r.sourceKey,
  runId: r.runId,
  lineId: r.lineId,
  dealKey: r.dealKey,
  payee: r.payee,
  department: r.department,
  typeName: r.typeName,
  methodName: r.methodName,
  amount: r.amount,
  capitalizedMonth: r.capitalizedMonth,
  bookedMonth: r.bookedMonth,
  startMonth: r.startMonth,
  endMonth: r.endMonth,
  months: r.months,
  byMonth: r.byMonth,
  amortizationAccount: r.amortizationAccount ?? null,
  writtenOffMonth: r.writtenOffMonth,
  writeOffReason: r.writeOffReason,
});

export async function accountingRoutes(app: FastifyInstance, db: Db) {
  await seedAccounting(db);

  // -- Settings --------------------------------------------------------------
  app.get('/api/accounting-settings', async () => loadSettings(db));
  app.put('/api/accounting-settings', async (req) => {
    const body = settingsSchema.parse(req.body);
    const cur = await loadSettings(db);
    await db
      .update(accountingPolicy)
      .set({
        defaultMethodId: body.defaultMethodId,
        defaultTermMonths: body.defaultTermMonths,
        practicalExpedient: body.practicalExpedient ? 1 : 0,
        reclassEnabled: body.reclassEnabled ? 1 : 0,
        reclassMode: body.reclassMode,
        accounts: body.accounts,
        updatedAt: new Date(),
      })
      .where(eq(accountingPolicy.id, cur.id));
    await db.insert(auditLog).values({ actor: actor(req), action: 'accounting_settings.update', entityType: 'accounting_policy', entityId: cur.id, detail: body });
    return loadSettings(db);
  });

  // -- Methods ---------------------------------------------------------------
  const methodsWithUse = async () => {
    const rows = await db.select().from(amortizationMethods).orderBy(asc(amortizationMethods.createdAt));
    const types = await db.select({ methodId: amortizationTypes.methodId, name: amortizationTypes.name }).from(amortizationTypes);
    return rows.map((m) => ({ ...m, usedBy: types.filter((t) => t.methodId === m.id).map((t) => t.name) }));
  };
  app.get('/api/amortization-methods', async () => methodsWithUse());
  const checkDef = (def: AmortizationMethodDef) => {
    const errs = validateMethod(def);
    if (errs.length) throw Object.assign(new Error(errs.join(' ')), { statusCode: 400 });
  };
  app.post('/api/amortization-methods', async (req) => {
    const body = methodSchema.parse(req.body);
    checkDef(body.def);
    const [row] = await db.insert(amortizationMethods).values({ name: body.name, description: body.description ?? null, def: body.def }).returning();
    await db.insert(auditLog).values({ actor: actor(req), action: 'amortization_method.create', entityType: 'amortization_method', entityId: row.id, detail: body });
    return row;
  });
  app.put('/api/amortization-methods/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = methodSchema.parse(req.body);
    checkDef(body.def);
    const [row] = await db
      .update(amortizationMethods)
      .set({ name: body.name, description: body.description ?? null, def: body.def, updatedAt: new Date() })
      .where(eq(amortizationMethods.id, id))
      .returning();
    if (!row) return reply.code(404).send({ error: 'Method not found' });
    await db.insert(auditLog).values({ actor: actor(req), action: 'amortization_method.update', entityType: 'amortization_method', entityId: id, detail: body });
    return row;
  });
  app.delete('/api/amortization-methods/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const s = await loadSettings(db);
    if (s.defaultMethodId === id) return reply.code(400).send({ error: 'This is the company default method; pick another default first.' });
    await db.delete(amortizationMethods).where(eq(amortizationMethods.id, id));
    await db.insert(auditLog).values({ actor: actor(req), action: 'amortization_method.delete', entityType: 'amortization_method', entityId: id });
    return reply.code(204).send();
  });
  /** A sample schedule for the method editor. */
  app.post('/api/amortization-methods/preview', async (req) => {
    const body = z
      .object({ def: methodDef, amount: z.number().default(12_000), payMonth: ym, contractStart: z.string().nullable().default(null), termMonths: z.number().nullable().default(null), practicalExpedient: z.boolean().default(false) })
      .parse(req.body);
    const errors = validateMethod(body.def);
    if (errors.length) return { errors, schedule: null };
    const s = await loadSettings(db);
    const sched = scheduleFor(body.amount, body.def, { payMonth: body.payMonth, contractStart: body.contractStart, termMonths: body.termMonths, defaultTermMonths: s.defaultTermMonths }, body.practicalExpedient);
    return { errors, schedule: sched };
  });

  // -- Types -----------------------------------------------------------------
  const typesWithRoles = async () => {
    const rows = await db.select().from(amortizationTypes).orderBy(asc(amortizationTypes.sortOrder), asc(amortizationTypes.name));
    const roles = await db.select({ id: employeeTypes.id, name: employeeTypes.name, amortizationTypeId: employeeTypes.amortizationTypeId, costTreatment: employeeTypes.costTreatment }).from(employeeTypes).orderBy(asc(employeeTypes.name));
    const builtinById = new Map(rows.filter((r) => r.builtinKey).map((r) => [r.builtinKey!, r.id]));
    return {
      types: rows.map((t) => ({ ...t, employeeTypes: roles.filter((r) => r.amortizationTypeId === t.id).map((r) => ({ id: r.id, name: r.name })) })),
      employeeTypes: roles.map((r) => {
        const key = suggestTypeKey(r.name);
        return { ...r, suggestedTypeId: r.amortizationTypeId ? null : key ? (builtinById.get(key) ?? null) : null };
      }),
    };
  };
  const setRoles = async (typeId: string, ids: string[] | undefined) => {
    if (!ids) return;
    await db.update(employeeTypes).set({ amortizationTypeId: null }).where(eq(employeeTypes.amortizationTypeId, typeId));
    if (ids.length) await db.update(employeeTypes).set({ amortizationTypeId: typeId }).where(inArray(employeeTypes.id, ids));
  };
  app.get('/api/amortization-types', async () => typesWithRoles());
  app.post('/api/amortization-types', async (req) => {
    const body = typeSchema.parse(req.body);
    const [row] = await db
      .insert(amortizationTypes)
      .values({ name: body.name, description: body.description ?? null, treatment: body.treatment, methodId: body.methodId ?? null, expenseAccount: body.expenseAccount ?? null, amortizationAccount: body.amortizationAccount ?? null, sortOrder: 100 })
      .returning();
    await setRoles(row.id, body.employeeTypeIds);
    await db.insert(auditLog).values({ actor: actor(req), action: 'amortization_type.create', entityType: 'amortization_type', entityId: row.id, detail: body });
    return typesWithRoles();
  });
  app.put('/api/amortization-types/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = typeSchema.parse(req.body);
    const [row] = await db
      .update(amortizationTypes)
      .set({ name: body.name, description: body.description ?? null, treatment: body.treatment, methodId: body.methodId ?? null, expenseAccount: body.expenseAccount ?? null, amortizationAccount: body.amortizationAccount ?? null, updatedAt: new Date() })
      .where(eq(amortizationTypes.id, id))
      .returning();
    if (!row) return reply.code(404).send({ error: 'Type not found' });
    await setRoles(id, body.employeeTypeIds);
    await db.insert(auditLog).values({ actor: actor(req), action: 'amortization_type.update', entityType: 'amortization_type', entityId: id, detail: body });
    return typesWithRoles();
  });
  app.delete('/api/amortization-types/:id', async (req) => {
    const { id } = req.params as { id: string };
    await db.delete(amortizationTypes).where(eq(amortizationTypes.id, id));
    await db.insert(auditLog).values({ actor: actor(req), action: 'amortization_type.delete', entityType: 'amortization_type', entityId: id });
    return typesWithRoles();
  });
  /** Map employee types to amortization types in one go (e.g. accept the suggestions). */
  app.post('/api/amortization-types/assign', async (req) => {
    const body = z.object({ assignments: z.array(z.object({ employeeTypeId: z.string().uuid(), amortizationTypeId: z.string().uuid().nullable() })) }).parse(req.body);
    for (const a of body.assignments) await db.update(employeeTypes).set({ amortizationTypeId: a.amortizationTypeId }).where(eq(employeeTypes.id, a.employeeTypeId));
    await db.insert(auditLog).values({ actor: actor(req), action: 'amortization_type.assign', entityType: 'employee_type', detail: body });
    return typesWithRoles();
  });

  // -- Register and close ----------------------------------------------------
  const periods = () => db.select().from(accountingPeriods).orderBy(asc(accountingPeriods.month));
  const allAssets = async () => (await db.select().from(amortizationAssets).orderBy(asc(amortizationAssets.bookedMonth), asc(amortizationAssets.payee))).map(toAsset);

  /** Commission lines from the chosen runs (all runs by default), ready for the close. */
  const closeLines = async (runIds: string[] | null): Promise<{ lines: CloseLineInput[]; runs: { id: string; name: string }[] }> => {
    const runs = await db.select({ id: commissionRuns.id, name: commissionRuns.name }).from(commissionRuns).orderBy(desc(commissionRuns.createdAt));
    const chosen = runIds ? runs.filter((r) => runIds.includes(r.id)) : runs;
    if (!chosen.length) return { lines: [], runs };
    // Newest run first, so a rerun's recalculated lines win over the original run's.
    const rank = new Map(chosen.map((r, i) => [r.id, i]));
    const rows = (await db.select().from(commissionLines).where(inArray(commissionLines.runId, chosen.map((r) => r.id))).orderBy(asc(commissionLines.id))).sort(
      (a, b) => rank.get(a.runId)! - rank.get(b.runId)! || a.id - b.id,
    );
    const payees = await payeeAccounting(db);
    const lines = rows.map((l) => {
      const e = payees.get(l.payee.trim().toLowerCase());
      return {
        sourceKey: lineSourceKey(l),
        runId: l.runId,
        lineId: l.id,
        dealKey: l.dealKey,
        payee: l.payee,
        role: l.role,
        department: e?.dept ?? 'Unassigned',
        amortizationTypeId: e?.typeId ?? null,
        fallbackTreatment: e?.treatment ?? 'capitalize',
        payout: l.payout,
        status: l.status,
        payMonth: l.payMonth,
        contractStart: l.contractStart,
        termMonths: l.termMonths,
      };
    });
    return { lines, runs };
  };

  /** What closing `month` would book, given what's closed already. */
  const preview = async (month: string, runIds: string[] | null) => {
    const ps = await periods();
    const last = ps[ps.length - 1];
    const next = last ? addMonths(last.month, 1) : null;
    if (ps.some((p) => p.month === month)) throw Object.assign(new Error(`${month} is already closed.`), { statusCode: 400 });
    if (next && month !== next) throw Object.assign(new Error(`Close ${next} first; months are closed in order.`), { statusCode: 400 });
    const settings = await loadSettings(db);
    const { methods, types } = await loadMethodsAndTypes(db);
    const { lines, runs } = await closeLines(runIds);
    const assets = await allAssets();
    const result = closeMonth({
      month,
      lines,
      assets,
      booked: bookedTotals(ps.flatMap((p) => ((p.summary as { booked?: BookedLine[] }).booked ?? []))),
      registerStart: ps[0]?.month ?? month,
      priorCurrent: last?.currentPortion ?? 0,
      settings,
      methods,
      types,
    });
    const unmapped = [...new Set(lines.filter((l) => !l.amortizationTypeId && l.department !== 'Unassigned').map((l) => l.department))];
    return { result, runs, settings, unmapped };
  };

  app.get('/api/accounting/periods', async () => {
    const ps = await periods();
    const { lines } = await closeLines(null);
    const payMonths = [...new Set(lines.filter((l) => l.payMonth && l.status !== 'hold').map((l) => l.payMonth!))].sort();
    const last = ps[ps.length - 1];
    return {
      periods: ps.map(({ bookedKeys: _k, entries, summary, ...p }) => ({ ...p, entryCount: entries.length, totals: (summary as { totals?: unknown }).totals ?? null, rollforward: (summary as { rollforward?: unknown }).rollforward ?? null })),
      nextMonth: last ? addMonths(last.month, 1) : (payMonths[0] ?? new Date().toISOString().slice(0, 7)),
      firstPayMonth: payMonths[0] ?? null,
      lastPayMonth: payMonths[payMonths.length - 1] ?? null,
    };
  });

  const runIdsQuery = (q: unknown) => {
    const { runIds } = z.object({ runIds: z.string().optional() }).parse(q ?? {});
    return runIds ? runIds.split(',').filter(Boolean) : null;
  };

  app.get('/api/accounting/close/:month', async (req) => {
    const month = ym.parse((req.params as { month: string }).month);
    const { result, runs, unmapped } = await preview(month, runIdsQuery(req.query));
    return { ...result, newAssets: result.newAssets.map(({ byMonth: _b, ...a }) => a), runs, unmapped, balanced: result.entries.every((e) => entryBalance(e).balanced) };
  });

  app.post('/api/accounting/close/:month', async (req, reply) => {
    const month = ym.parse((req.params as { month: string }).month);
    const body = z.object({ runIds: z.array(z.string().uuid()).nullable().default(null) }).parse(req.body ?? {});
    const { result, runs } = await preview(month, body.runIds);
    if (!result.entries.every((e) => entryBalance(e).balanced)) return reply.code(400).send({ error: 'Journals do not balance; nothing was closed.' });
    const { newAssets, ...summary } = result;
    // One transaction: a failed asset insert must not leave a closed month whose lines count as booked.
    // The unique month column stops a concurrent close of the same month.
    await db.transaction(async (tx) => {
      const [period] = await tx
        .insert(accountingPeriods)
        .values({
          month,
          runIds: body.runIds ?? runs.map((r) => r.id),
          entries: result.entries,
          summary: { totals: summary.totals, rollforward: summary.rollforward, reclass: summary.reclass, booked: summary.booked, excluded: summary.excluded, warnings: summary.warnings },
          bookedKeys: result.booked.map((b) => b.sourceKey),
          currentPortion: result.reclass?.target ?? 0,
          closedBy: actor(req),
        })
        .returning();
      for (let i = 0; i < newAssets.length; i += 500) {
        await tx.insert(amortizationAssets).values(newAssets.slice(i, i + 500).map(({ id: _id, ...a }) => ({ ...a, periodId: period.id })));
      }
      await tx.insert(auditLog).values({ actor: actor(req), action: 'accounting_period.close', entityType: 'accounting_period', entityId: period.id, detail: { month, totals: result.totals } });
      // Re-check order inside the transaction: the previous month must still be the latest closed.
      const prior = await tx.select({ month: accountingPeriods.month }).from(accountingPeriods).orderBy(desc(accountingPeriods.month)).limit(2);
      if (prior[1] && prior[1].month !== addMonths(month, -1)) throw Object.assign(new Error('Another close changed the books; refresh and try again.'), { statusCode: 409 });
    });
    return { month, totals: result.totals };
  });

  app.post('/api/accounting/periods/:month/reopen', async (req, reply) => {
    const month = ym.parse((req.params as { month: string }).month);
    const ps = await periods();
    const last = ps[ps.length - 1];
    if (!last || last.month !== month) return reply.code(400).send({ error: 'Only the latest closed month can be reopened.' });
    // Write-offs recorded for this month stay pending for the next close.
    await db.delete(accountingPeriods).where(eq(accountingPeriods.id, last.id));
    await db.insert(auditLog).values({ actor: actor(req), action: 'accounting_period.reopen', entityType: 'accounting_period', entityId: last.id, detail: { month } });
    return { ok: true };
  });

  /** Journals for a month: stored for a closed month, previewed for the next open one. */
  const journalsFor = async (month: string): Promise<{ entries: JournalEntry[]; closed: boolean }> => {
    const [p] = await db.select().from(accountingPeriods).where(eq(accountingPeriods.month, month));
    if (p) return { entries: p.entries, closed: true };
    const { result } = await preview(month, null);
    return { entries: result.entries, closed: false };
  };
  app.get('/api/accounting/journals/:month', async (req) => {
    const month = ym.parse((req.params as { month: string }).month);
    return { month, ...(await journalsFor(month)) };
  });
  app.get('/api/accounting/journals/:month/entries.csv', async (req, reply) => {
    const month = ym.parse((req.params as { month: string }).month);
    const { entries } = await journalsFor(month);
    const [y, m] = month.split('-').map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    const rows = entries.flatMap((e, i) =>
      e.lines.map((l) => ({
        'Journal ID': `COMM-${month}-${String(i + 1).padStart(2, '0')}`,
        Date: lastDay,
        Type: e.kind ?? '',
        Memo: e.memo,
        'Account Number': l.accountNumber ?? '',
        Account: l.account,
        Department: l.department ?? '',
        Debit: num(l.debit),
        Credit: num(l.credit),
      })),
    );
    return csvReply(reply, `commission-journals-${month}.csv`, ['Journal ID', 'Date', 'Type', 'Memo', 'Account Number', 'Account', 'Department', 'Debit', 'Credit'], rows);
  });

  // -- Register --------------------------------------------------------------
  const registerAt = async (month: string) => {
    const assets = await allAssets();
    const inScope = assets.filter((a) => a.bookedMonth <= month);
    const rows = inScope.map((a) => {
      const { byMonth: _b, ...rest } = a;
      return { ...rest, ...assetPosition(a, month) };
    });
    const ps = await periods();
    const history = ps.filter((p) => p.month <= month).map((p) => registerRollforward(assets, p.month));
    const byType = new Map<string, { typeName: string; count: number; amount: number; remaining: number; current: number; noncurrent: number; amortizationThisMonth: number }>();
    for (const r of rows) {
      const t = byType.get(r.typeName) ?? { typeName: r.typeName, count: 0, amount: 0, remaining: 0, current: 0, noncurrent: 0, amortizationThisMonth: 0 };
      t.count++;
      t.amount += r.amount;
      t.remaining += r.remaining;
      t.current += r.current;
      t.noncurrent += r.noncurrent;
      t.amortizationThisMonth += r.amortizationThisMonth;
      byType.set(r.typeName, t);
    }
    // Expected amortization of today's balance, by year, for the waterfall.
    const waterfall: { year: string; amount: number }[] = [];
    const byYear = new Map<string, number>();
    for (const a of inScope) {
      if (a.writtenOffMonth && a.writtenOffMonth <= month) continue;
      for (const [m, v] of Object.entries(a.byMonth)) if (m > month && !(a.writtenOffMonth && m >= a.writtenOffMonth)) byYear.set(m.slice(0, 4), (byYear.get(m.slice(0, 4)) ?? 0) + v);
    }
    for (const [year, amount] of [...byYear.entries()].sort()) waterfall.push({ year, amount: Math.round(amount * 100) / 100 });
    const round = (n: number) => Math.round(n * 100) / 100;
    return {
      month,
      closed: ps.some((p) => p.month === month),
      rows,
      rollforward: registerRollforward(assets, month),
      history,
      byType: [...byType.values()].map((t) => ({ ...t, amount: round(t.amount), remaining: round(t.remaining), current: round(t.current), noncurrent: round(t.noncurrent), amortizationThisMonth: round(t.amortizationThisMonth) })),
      waterfall,
      openMonth: ps.length ? addMonths(ps[ps.length - 1].month, 1) : null,
    };
  };

  app.get('/api/accounting/register', async (req) => {
    const ps = await periods();
    const q = z.object({ month: ym.optional() }).parse(req.query ?? {});
    const month = q.month ?? ps[ps.length - 1]?.month ?? new Date().toISOString().slice(0, 7);
    return registerAt(month);
  });

  app.get('/api/accounting/register.csv', async (req, reply) => {
    const ps = await periods();
    const q = z.object({ month: ym.optional() }).parse(req.query ?? {});
    const month = q.month ?? ps[ps.length - 1]?.month ?? new Date().toISOString().slice(0, 7);
    const reg = await registerAt(month);
    const cols = ['Deal', 'Payee', 'Department', 'Amortization Type', 'Method', 'Amount', 'Capitalized', 'Booked', 'Start', 'End', 'Months', 'Amortized To Date', 'Written Off', 'Remaining', 'Current', 'Non-current', `Amortization ${month}`, 'Status', 'Write-off Month', 'Write-off Reason'];
    const rows = reg.rows.map((r) => ({
      Deal: r.dealKey ?? '',
      Payee: r.payee,
      Department: r.department,
      'Amortization Type': r.typeName,
      Method: r.methodName,
      Amount: String(r.amount),
      Capitalized: r.capitalizedMonth,
      Booked: r.bookedMonth,
      Start: r.startMonth,
      End: r.endMonth,
      Months: String(r.months),
      'Amortized To Date': String(r.amortizedToDate),
      'Written Off': num(r.impaired),
      Remaining: String(r.remaining),
      Current: String(r.current),
      'Non-current': String(r.noncurrent),
      [`Amortization ${month}`]: String(r.amortizationThisMonth),
      Status: r.status,
      'Write-off Month': r.writtenOffMonth ?? '',
      'Write-off Reason': r.writeOffReason ?? '',
    }));
    return csvReply(reply, `amortization-register-${month}.csv`, cols, rows);
  });

  /** Full month-by-month schedule of every asset (long form, for the ERP or a spreadsheet). */
  app.get('/api/accounting/register/schedule.csv', async (_req, reply) => {
    const assets = await allAssets();
    const months = [...new Set(assets.flatMap((a) => Object.keys(a.byMonth)))].sort();
    const cols = ['Deal', 'Payee', 'Department', 'Amortization Type', 'Amount', 'Start', 'End', ...months];
    const rows = assets.map((a) => ({
      Deal: a.dealKey ?? '',
      Payee: a.payee,
      Department: a.department,
      'Amortization Type': a.typeName,
      Amount: String(a.amount),
      Start: a.startMonth,
      End: a.endMonth,
      ...Object.fromEntries(months.map((m) => [m, a.byMonth[m] === undefined ? '' : String(a.byMonth[m])])),
    }));
    return csvReply(reply, 'amortization-schedule.csv', cols, rows);
  });

  /** Write off an asset's remaining balance in the next open month (churn, early termination). */
  app.post('/api/accounting/assets/:id/write-off', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ reason: z.string().min(1).max(500) }).parse(req.body);
    const ps = await periods();
    if (!ps.length) return reply.code(400).send({ error: 'Nothing is closed yet.' });
    const open = addMonths(ps[ps.length - 1].month, 1);
    const [a] = await db.select().from(amortizationAssets).where(eq(amortizationAssets.id, id));
    if (!a) return reply.code(404).send({ error: 'Asset not found' });
    if (a.writtenOffMonth && a.writtenOffMonth < open) return reply.code(400).send({ error: `Already written off in ${a.writtenOffMonth}.` });
    await db.update(amortizationAssets).set({ writtenOffMonth: open, writeOffReason: body.reason, updatedAt: new Date() }).where(eq(amortizationAssets.id, id));
    await db.insert(auditLog).values({ actor: actor(req), action: 'amortization_asset.write_off', entityType: 'amortization_asset', entityId: id, detail: { month: open, reason: body.reason } });
    return { writtenOffMonth: open };
  });
  app.delete('/api/accounting/assets/:id/write-off', async (req, reply) => {
    const { id } = req.params as { id: string };
    const ps = await periods();
    const open = ps.length ? addMonths(ps[ps.length - 1].month, 1) : null;
    const [a] = await db.select().from(amortizationAssets).where(eq(amortizationAssets.id, id));
    if (!a) return reply.code(404).send({ error: 'Asset not found' });
    if (!a.writtenOffMonth || (open && a.writtenOffMonth < open)) return reply.code(400).send({ error: 'Only a pending write-off (in the open month) can be undone.' });
    await db.update(amortizationAssets).set({ writtenOffMonth: null, writeOffReason: null, updatedAt: new Date() }).where(eq(amortizationAssets.id, id));
    await db.insert(auditLog).values({ actor: actor(req), action: 'amortization_asset.undo_write_off', entityType: 'amortization_asset', entityId: id });
    return { ok: true };
  });

  // -- Reclass ---------------------------------------------------------------
  /** Current / non-current by closed month, with the reclass entries booked. */
  app.get('/api/accounting/reclass', async () => {
    const ps = await periods();
    const assets = await allAssets();
    return ps.map((p) => {
      const rf = registerRollforward(assets, p.month);
      const reclass = (p.summary as { reclass?: unknown }).reclass ?? null;
      return { month: p.month, closing: rf.closing, current: p.currentPortion, noncurrent: Math.round((rf.closing - p.currentPortion) * 100) / 100, reclass, entries: p.entries.filter((e) => e.kind === 'reclass') };
    });
  });
}
