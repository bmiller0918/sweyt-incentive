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
  futureAmortization,
  manualSchedule,
  rescheduleAsset,
  rollforwardRange,
  type AccountingSettings,
  type AssetModification,
  type AmortizationMethodDef,
  type AmortizationTypeDef,
  type BookedLine,
  type CloseLineInput,
  type JournalEntry,
  type NamedMethod,
  type RegisterAsset,
} from '@commissions/shared';
import { and, asc, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getAppSettings, recordNumber } from '../appSettings.js';
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

type AssetDbRow = typeof amortizationAssets.$inferSelect;
const toAsset = (r: AssetDbRow): RegisterAsset => ({
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
  bookedMonth: r.bookedMonth ?? '',
  startMonth: r.startMonth,
  endMonth: r.endMonth,
  months: r.months,
  byMonth: r.byMonth,
  amortizationAccount: r.amortizationAccount ?? null,
  writtenOffMonth: r.writtenOffMonth,
  writeOffReason: r.writeOffReason,
  origin: r.origin,
  opening: r.opening,
  offsetAccount: r.offsetAccount ?? null,
});

/** AMRT0001-style id of a register row. */
export const assetCode = (n: number) => recordNumber(n);
/** What to call a row in lists: its name, or deal and payee for a commission. */
const assetName = (r: AssetDbRow) => r.name || [r.dealKey, r.payee].filter(Boolean).join(' · ');
/** Display fields every register row carries alongside its accounting. */
const assetInfo = (r: AssetDbRow) => ({
  number: r.number,
  code: assetCode(r.number),
  name: assetName(r),
  description: r.description,
  typeId: r.typeId,
  methodId: r.methodId,
  createdAt: r.createdAt,
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
  /** Booked register rows (every commission asset, and manual ones whose month has closed). */
  const bookedRows = () => db.select().from(amortizationAssets).where(isNotNull(amortizationAssets.bookedMonth)).orderBy(asc(amortizationAssets.number));
  const allAssets = async () => (await bookedRows()).map(toAsset);
  /** Manual amortizations entered but not booked by a close yet. */
  const pendingRows = () => db.select().from(amortizationAssets).where(isNull(amortizationAssets.bookedMonth)).orderBy(asc(amortizationAssets.number));
  const openMonthOf = (ps: { month: string }[]) => (ps.length ? addMonths(ps[ps.length - 1].month, 1) : null);
  const note = (req: FastifyRequest, action: string, changes: AssetModification['changes'] = [], extra: Partial<AssetModification> = {}): AssetModification => ({
    at: new Date().toISOString(),
    by: actor(req),
    action,
    effectiveMonth: null,
    changes,
    note: null,
    ...extra,
  });

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
    const pending = (await pendingRows()).map(toAsset);
    const result = closeMonth({
      month,
      lines,
      assets,
      pending,
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
    const goLive = getAppSettings().general.goLiveDate;
    if (goLive && month < goLive.slice(0, 7)) return reply.code(400).send({ error: `Nothing is booked before the go-live date (${goLive}); ${month} cannot be closed.` });
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
      const fromLines = newAssets.filter((a) => a.origin !== 'manual');
      const booked: AssetModification = { at: new Date().toISOString(), by: actor(req), action: 'booked', effectiveMonth: month, changes: [], note: `Booked by the ${month} close` };
      for (let i = 0; i < fromLines.length; i += 500) {
        await tx
          .insert(amortizationAssets)
          .values(
            fromLines.slice(i, i + 500).map(({ id, origin: _o, opening: _op, offsetAccount: _oa, ...a }) => ({
              ...a,
              // A recalculated payout's difference is its own row; say so, since it shares the deal and payee.
              name: id.endsWith(':adj') ? `${[a.dealKey, a.payee].filter(Boolean).join(' · ')} (recalculated)` : null,
              origin: 'commission' as const,
              periodId: period.id,
              history: [booked],
            })),
          );
      }
      for (const m of newAssets.filter((a) => a.origin === 'manual')) {
        const [cur] = await tx.select({ history: amortizationAssets.history }).from(amortizationAssets).where(eq(amortizationAssets.id, m.id));
        await tx
          .update(amortizationAssets)
          .set({ periodId: period.id, bookedMonth: month, history: [...(cur?.history ?? []), booked], updatedAt: new Date() })
          .where(and(eq(amortizationAssets.id, m.id), isNull(amortizationAssets.bookedMonth)));
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
    if (!getAppSettings().general.allowReopenClosedMonth) return reply.code(403).send({ error: 'Reopening a closed month is switched off (Setup › General › Period controls).' });
    const ps = await periods();
    const last = ps[ps.length - 1];
    if (!last || last.month !== month) return reply.code(400).send({ error: 'Only the latest closed month can be reopened.' });
    // Commission amortizations booked by this month are rebuilt by the next close, so edits made to them since would be lost.
    const { force } = z.object({ force: z.boolean().default(false) }).parse(req.body ?? {});
    if (!force) {
      const changed = (await db.select({ history: amortizationAssets.history }).from(amortizationAssets).where(and(eq(amortizationAssets.periodId, last.id), eq(amortizationAssets.origin, 'commission')))).filter(
        (r) => r.history.some((h) => h.action !== 'booked'),
      ).length;
      if (changed)
        return reply.code(409).send({
          error: `${changed} commission amortization${changed === 1 ? ' booked in this month was' : 's booked in this month were'} modified, transferred or written off since. Reopening removes them and the next close books them again as calculated, without those changes.`,
          code: 'changes_lost',
        });
    }
    // Write-offs recorded for this month stay pending for the next close.
    // Commission assets it booked are deleted (the next close books them again); manual ones go back to pending.
    await db.transaction(async (tx) => {
      await tx.delete(amortizationAssets).where(and(eq(amortizationAssets.periodId, last.id), eq(amortizationAssets.origin, 'commission')));
      const manual = await tx.select().from(amortizationAssets).where(and(eq(amortizationAssets.periodId, last.id), eq(amortizationAssets.origin, 'manual')));
      for (const m of manual)
        await tx
          .update(amortizationAssets)
          .set({ periodId: null, bookedMonth: null, history: [...m.history, note(req, 'unbooked', [], { effectiveMonth: month, note: `${month} was reopened` })], updatedAt: new Date() })
          .where(eq(amortizationAssets.id, m.id));
      await tx.delete(accountingPeriods).where(eq(accountingPeriods.id, last.id));
    });
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
    const dbRows = await bookedRows();
    const assets = dbRows.map(toAsset);
    const inScope = assets.filter((a) => a.bookedMonth <= month);
    const info = new Map(dbRows.map((r) => [r.id, assetInfo(r)]));
    const rows = inScope.map((a) => {
      const { byMonth: _b, ...rest } = a;
      return { ...rest, ...info.get(a.id)!, ...assetPosition(a, month) };
    });
    // Manual amortizations waiting for their month's close.
    const pending = (await pendingRows()).map((r) => {
      const { byMonth: _b, ...rest } = toAsset(r);
      return { ...rest, ...assetInfo(r), amortizedToDate: 0, impaired: 0, remaining: r.amount, amortizationThisMonth: 0, impairmentThisMonth: 0, current: 0, noncurrent: 0, status: 'pending' as const };
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
      pending,
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
    const cols = ['ID', 'Name', 'Source', 'Deal', 'Payee', 'Department', 'Amortization Type', 'Method', 'Amount', 'Capitalized', 'Booked', 'Start', 'End', 'Months', 'Amortized To Date', 'Written Off', 'Remaining', 'Current', 'Non-current', `Amortization ${month}`, 'Status', 'Write-off Month', 'Write-off Reason'];
    const rows = [...reg.rows, ...reg.pending].map((r) => ({
      ID: r.code,
      Name: r.name,
      Source: r.origin === 'manual' ? 'Manual' : 'Commission',
      Deal: r.dealKey ?? '',
      Payee: r.payee,
      Department: r.department,
      'Amortization Type': r.typeName,
      Method: r.methodName,
      Amount: String(r.amount),
      Capitalized: r.capitalizedMonth,
      Booked: r.bookedMonth || 'Pending',
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
    if (!a.bookedMonth) return reply.code(400).send({ error: 'This amortization is not booked yet; delete it instead.' });
    if (a.writtenOffMonth && a.writtenOffMonth < open) return reply.code(400).send({ error: `Already written off in ${a.writtenOffMonth}.` });
    const pos = assetPosition(toAsset(a), ps[ps.length - 1].month);
    await db
      .update(amortizationAssets)
      .set({ writtenOffMonth: open, writeOffReason: body.reason, history: [...a.history, note(req, 'written_off', [{ field: 'Remaining balance', from: pos.remaining, to: 0 }], { effectiveMonth: open, note: body.reason })], updatedAt: new Date() })
      .where(eq(amortizationAssets.id, id));
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
    await db
      .update(amortizationAssets)
      .set({ writtenOffMonth: null, writeOffReason: null, history: [...a.history, note(req, 'write_off_undone', [], { effectiveMonth: a.writtenOffMonth })], updatedAt: new Date() })
      .where(eq(amortizationAssets.id, id));
    await db.insert(auditLog).values({ actor: actor(req), action: 'amortization_asset.undo_write_off', entityType: 'amortization_asset', entityId: id });
    return { ok: true };
  });


  // -- Amortization records (create, view, modify, transfer, delete) --------
  const manualSchema = z.object({
    name: z.string().trim().min(1).max(200),
    payee: z.string().trim().min(1).max(200),
    department: z.string().trim().max(200).default(''),
    typeId: z.string().uuid().nullable().default(null),
    methodId: z.string().uuid().nullable().default(null),
    amount: z.number().finite().refine((n) => n !== 0, 'Enter an amount.'),
    capitalizedMonth: ym,
    startMonth: ym,
    months: z.number().int().min(1).max(600),
    description: z.string().max(2000).nullable().default(null),
    dealKey: z.string().max(200).nullable().default(null),
    opening: z.boolean().default(false),
    offsetAccount: glAccount.nullable().default(null),
  });
  type ManualInput = z.infer<typeof manualSchema>;

  /** Type, method, accounts and schedule of a manual amortization, from its inputs. */
  const buildManual = async (b: ManualInput) => {
    const { methods, types } = await loadMethodsAndTypes(db);
    const type = b.typeId ? types.find((t) => t.id === b.typeId) : null;
    if (b.typeId && !type) throw Object.assign(new Error('That amortization type no longer exists.'), { statusCode: 400 });
    const method = b.methodId ? methods.find((m) => m.id === b.methodId) : null;
    if (b.methodId && !method) throw Object.assign(new Error('That method no longer exists.'), { statusCode: 400 });
    if (b.startMonth < b.capitalizedMonth && !b.opening) throw Object.assign(new Error('Amortization cannot start before the month the cost is capitalized.'), { statusCode: 400 });
    let sched: ReturnType<typeof manualSchedule>;
    try {
      sched = manualSchedule({ amount: b.amount, startMonth: b.startMonth, months: b.months, def: method?.def ?? null });
    } catch (e) {
      throw Object.assign(e as Error, { statusCode: 400 });
    }
    return {
      name: b.name,
      payee: b.payee,
      department: b.department || 'Unassigned',
      typeId: type?.id ?? null,
      typeName: type?.name ?? 'No amortization type',
      methodId: method?.id ?? null,
      methodName: method?.name ?? 'Straight-line',
      amount: Math.round(b.amount * 100) / 100,
      capitalizedMonth: b.capitalizedMonth,
      description: b.description,
      dealKey: b.dealKey,
      opening: b.opening,
      offsetAccount: b.opening ? null : b.offsetAccount,
      amortizationAccount: type?.amortizationAccount ?? null,
      ...sched,
    };
  };

  app.post('/api/accounting/assets/preview', async (req) => {
    const built = await buildManual(manualSchema.parse(req.body));
    return { startMonth: built.startMonth, endMonth: built.endMonth, months: built.months, byMonth: built.byMonth };
  });

  /** A new amortization entered by hand. It books with the close of its capitalized month (or the next open month). */
  app.post('/api/accounting/assets', async (req, reply) => {
    if (!getAppSettings().general.allowManualAmortizations) return reply.code(403).send({ error: 'Entering amortizations by hand is switched off (Setup › General › Allow direct input of amortization records).' });
    const built = await buildManual(manualSchema.parse(req.body));
    const [row] = await db
      .insert(amortizationAssets)
      .values({
        ...built,
        origin: 'manual',
        sourceKey: `manual:${randomUUID()}`,
        runId: null,
        lineId: null,
        periodId: null,
        bookedMonth: null,
        history: [note(req, 'created', [], { note: built.opening ? 'Opening balance' : null })],
      })
      .returning();
    await db.insert(auditLog).values({ actor: actor(req), action: 'amortization_asset.create', entityType: 'amortization_asset', entityId: row.id, detail: { code: assetCode(row.number), amount: row.amount } });
    return { id: row.id, code: assetCode(row.number) };
  });

  /** One amortization with its schedule, journals, accounts and history. */
  app.get('/api/accounting/assets/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [r] = await db.select().from(amortizationAssets).where(eq(amortizationAssets.id, id));
    if (!r) return reply.code(404).send({ error: 'Amortization not found' });
    const ps = await periods();
    const settings = await loadSettings(db);
    const A = settings.accounts;
    const lastClosed = ps[ps.length - 1]?.month ?? null;
    const openMonth = openMonthOf(ps);
    const closed = new Map(ps.map((p) => [p.month, p]));
    const a = toAsset(r);
    const booked = !!r.bookedMonth;
    const pos = booked && lastClosed && r.bookedMonth! <= lastClosed ? assetPosition(a, lastClosed) : null;
    /** Journal id of an entry kind in a closed month, numbered as the CSV export numbers it. */
    const journalRef = (month: string, kind: string) => {
      const p = closed.get(month);
      if (!p) return null;
      const i = p.entries.findIndex((e) => e.kind === kind);
      return i < 0 ? null : `COMM-${month}-${String(i + 1).padStart(2, '0')}`;
    };
    const lastDay = (m: string) => {
      const [y, mo] = m.split('-').map(Number);
      return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
    };
    type State = 'booked' | 'next_close' | 'scheduled' | 'pending';
    const stateOf = (m: string): State => (closed.has(m) ? 'booked' : !booked ? 'pending' : m === openMonth ? 'next_close' : 'scheduled');

    // Schedule: the initial balance, each month's amortization, and a write-off if any.
    const schedule: { period: number; type: string; start: string; end: string; amount: number; remaining: number; journal: string | null; state: State }[] = [];
    const addMonth = r.bookedMonth ?? r.capitalizedMonth;
    schedule.push({
      period: 0,
      type: r.opening ? 'Opening balance' : 'Initial balance',
      start: `${addMonth}-01`,
      end: lastDay(addMonth),
      amount: r.amount,
      remaining: r.amount,
      journal: r.opening ? null : journalRef(addMonth, r.origin === 'manual' ? 'addition' : 'accrual'),
      state: stateOf(addMonth),
    });
    let remaining = r.amount;
    const months = Object.keys(r.byMonth).sort();
    let n = 0;
    for (const m of months) {
      if (r.writtenOffMonth && m >= r.writtenOffMonth) break;
      n++;
      remaining = Math.round((remaining - r.byMonth[m]) * 100) / 100;
      // Amortization scheduled before the asset was booked is caught up in its booked month.
      const bookedIn = r.bookedMonth && m < r.bookedMonth ? r.bookedMonth : m;
      schedule.push({ period: n, type: 'Amortization', start: `${m}-01`, end: lastDay(m), amount: r.byMonth[m], remaining, journal: journalRef(bookedIn, 'amortization'), state: stateOf(bookedIn) });
    }
    if (r.writtenOffMonth) {
      schedule.push({ period: n + 1, type: 'Write-off', start: `${r.writtenOffMonth}-01`, end: lastDay(r.writtenOffMonth), amount: remaining, remaining: 0, journal: journalRef(r.writtenOffMonth, 'impairment'), state: stateOf(r.writtenOffMonth) });
    }
    const remainingPeriods = months.filter((m) => (!pos || !lastClosed || m > lastClosed) && !(r.writtenOffMonth && m >= r.writtenOffMonth)).length;

    const deferredCredit = settings.reclassEnabled && settings.reclassMode === 'true_up' ? A.deferredCurrent : A.deferredNoncurrent;
    const accounts = [
      { role: 'Asset (non-current)', account: A.deferredNoncurrent, note: 'Debited when capitalized' },
      ...(settings.reclassEnabled ? [{ role: 'Asset (current)', account: A.deferredCurrent, note: 'The next 12 months, moved by the monthly reclass' }] : []),
      { role: 'Amortization expense', account: r.amortizationAccount ?? A.amortizationExpense, note: `Debited monthly to ${r.department}, against ${deferredCredit.number} ${deferredCredit.name}` },
      { role: 'Write-off expense', account: A.impairmentExpense, note: 'If written off' },
      ...(r.opening
        ? []
        : [
            {
              role: 'Offset (credit when capitalized)',
              account: r.origin === 'manual' ? (r.offsetAccount ?? A.accruedCommissions) : A.accruedCommissions,
              note: r.origin === 'manual' ? 'Chosen on the amortization' : 'Commissions owed to the payee',
            },
          ]),
    ];
    const run = r.runId ? (await db.select({ name: commissionRuns.name }).from(commissionRuns).where(eq(commissionRuns.id, r.runId)))[0] : undefined;
    const { byMonth: _b, ...rest } = a;
    return {
      ...rest,
      ...assetInfo(r),
      bookedMonth: r.bookedMonth,
      status: !booked ? 'pending' : pos ? pos.status : 'not_started',
      runName: run?.name ?? null,
      remaining: pos ? pos.remaining : r.amount,
      amortizedToDate: pos?.amortizedToDate ?? 0,
      current: pos?.current ?? 0,
      noncurrent: pos?.noncurrent ?? 0,
      remainingPeriods,
      asOf: lastClosed,
      openMonth,
      schedule,
      accounts,
      history: r.history,
      editable: !booked,
    };
  });

  const modifySchema = z.object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
    dealKey: z.string().max(200).nullable().optional(),
    startMonth: ym.optional(),
    endMonth: ym.optional(),
    note: z.string().max(500).nullable().default(null),
  });

  /**
   * Modify an amortization. Before it is booked every field can change.
   * After, the name and description can, and the schedule changes
   * prospectively: closed months stay as booked and what is left is
   * spread evenly from the open month to the new end.
   */
  app.put('/api/accounting/assets/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [r] = await db.select().from(amortizationAssets).where(eq(amortizationAssets.id, id));
    if (!r) return reply.code(404).send({ error: 'Amortization not found' });
    const changes: AssetModification['changes'] = [];
    const track = (field: string, from: string | number | null, to: string | number | null) => {
      if (from !== to) changes.push({ field, from, to });
    };
    if (!r.bookedMonth) {
      if (r.origin !== 'manual') return reply.code(400).send({ error: 'Commission amortizations come from a close.' });
      const b = manualSchema.extend({ note: z.string().max(500).nullable().default(null) }).parse(req.body);
      const built = await buildManual(b);
      track('Name', r.name, built.name);
      track('Payee', r.payee, built.payee);
      track('Department', r.department, built.department);
      track('Type', r.typeName, built.typeName);
      track('Method', r.methodName, built.methodName);
      track('Amount', r.amount, built.amount);
      track('Capitalized', r.capitalizedMonth, built.capitalizedMonth);
      track('Start', r.startMonth, built.startMonth);
      track('End', r.endMonth, built.endMonth);
      track('Offset account', r.offsetAccount?.number ?? null, built.offsetAccount?.number ?? null);
      track('Opening balance', r.opening ? 'Yes' : 'No', built.opening ? 'Yes' : 'No');
      track('Description', r.description, built.description);
      track('Reference', r.dealKey, built.dealKey);
      if (!changes.length) return { ok: true };
      await db
        .update(amortizationAssets)
        .set({ ...built, history: [...r.history, note(req, 'modified', changes, { note: b.note })], updatedAt: new Date() })
        .where(eq(amortizationAssets.id, id));
      return { ok: true };
    }
    const b = modifySchema.parse(req.body);
    const open = openMonthOf(await periods())!;
    const set: Partial<typeof amortizationAssets.$inferInsert> = {};
    if (b.name !== undefined) {
      track('Name', assetName(r), b.name);
      set.name = b.name;
    }
    if (b.description !== undefined) {
      track('Description', r.description, b.description);
      set.description = b.description;
    }
    if (b.dealKey !== undefined) {
      track('Reference', r.dealKey, b.dealKey);
      set.dealKey = b.dealKey;
    }
    let effectiveMonth: string | null = null;
    if ((b.endMonth && b.endMonth !== r.endMonth) || (b.startMonth && b.startMonth !== r.startMonth)) {
      if (r.writtenOffMonth) return reply.code(400).send({ error: 'A written-off amortization cannot be rescheduled.' });
      try {
        const next = rescheduleAsset(r, open, { startMonth: b.startMonth, endMonth: b.endMonth ?? r.endMonth });
        track('Start', r.startMonth, next.startMonth);
        track('End', r.endMonth, next.endMonth);
        track('Term (months)', r.months, next.months);
        Object.assign(set, next, { methodName: r.methodName.endsWith('(modified)') ? r.methodName : `${r.methodName} (modified)` });
        effectiveMonth = open;
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    }
    if (!changes.length) return { ok: true };
    await db
      .update(amortizationAssets)
      .set({ ...set, history: [...r.history, note(req, 'modified', changes, { effectiveMonth, note: b.note })], updatedAt: new Date() })
      .where(eq(amortizationAssets.id, id));
    await db.insert(auditLog).values({ actor: actor(req), action: 'amortization_asset.modify', entityType: 'amortization_asset', entityId: id, detail: { changes } });
    return { ok: true };
  });

  /** Move an amortization to another department or type; its amortization from the open month on is charged there. */
  app.post('/api/accounting/assets/:id/transfer', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = z.object({ department: z.string().trim().min(1).max(200), typeId: z.string().uuid().nullable(), note: z.string().max(500).nullable().default(null) }).parse(req.body);
    const [r] = await db.select().from(amortizationAssets).where(eq(amortizationAssets.id, id));
    if (!r) return reply.code(404).send({ error: 'Amortization not found' });
    const { types } = await loadMethodsAndTypes(db);
    const type = b.typeId ? types.find((t) => t.id === b.typeId) : null;
    if (b.typeId && !type) return reply.code(400).send({ error: 'That amortization type no longer exists.' });
    const changes: AssetModification['changes'] = [];
    if (r.department !== b.department) changes.push({ field: 'Department', from: r.department, to: b.department });
    if (type && r.typeName !== type.name) changes.push({ field: 'Type', from: r.typeName, to: type.name });
    if (!changes.length) return { ok: true };
    const ps = await periods();
    await db
      .update(amortizationAssets)
      .set({
        department: b.department,
        ...(type ? { typeId: type.id, typeName: type.name, amortizationAccount: type.amortizationAccount ?? null } : {}),
        history: [...r.history, note(req, 'transferred', changes, { effectiveMonth: r.bookedMonth ? openMonthOf(ps) : null, note: b.note })],
        updatedAt: new Date(),
      })
      .where(eq(amortizationAssets.id, id));
    await db.insert(auditLog).values({ actor: actor(req), action: 'amortization_asset.transfer', entityType: 'amortization_asset', entityId: id, detail: { changes } });
    return { ok: true };
  });

  /** Delete a manual amortization that is not booked yet. */
  app.delete('/api/accounting/assets/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [r] = await db.select().from(amortizationAssets).where(eq(amortizationAssets.id, id));
    if (!r) return reply.code(404).send({ error: 'Amortization not found' });
    if (r.origin !== 'manual' || r.bookedMonth) return reply.code(400).send({ error: 'Only a manual amortization that is not booked yet can be deleted. Write it off instead.' });
    await db.delete(amortizationAssets).where(eq(amortizationAssets.id, id));
    await db.insert(auditLog).values({ actor: actor(req), action: 'amortization_asset.delete', entityType: 'amortization_asset', entityId: id, detail: { code: assetCode(r.number), name: r.name } });
    return { ok: true };
  });

  // -- Reports ---------------------------------------------------------------
  /** Rollforward of each amortization over a range of months; the page groups and totals it. */
  app.get('/api/accounting/reports/rollforward', async (req) => {
    const q = z.object({ from: ym, to: ym }).parse(req.query ?? {});
    if (q.to < q.from) throw Object.assign(new Error('"To" must be on or after "From".'), { statusCode: 400 });
    const ps = await periods();
    const rows = (await bookedRows())
      .map((r) => ({ r, rf: rollforwardRange(toAsset(r), q.from, q.to) }))
      .filter(({ rf }) => rf.initial || rf.additions || rf.amortization || rf.writeOffs || rf.ending)
      .map(({ r, rf }) => ({ id: r.id, code: assetCode(r.number), name: assetName(r), origin: r.origin, payee: r.payee, department: r.department, typeName: r.typeName, ...rf }));
    const lastClosed = ps[ps.length - 1]?.month ?? null;
    return { from: q.from, to: q.to, lastClosed, projected: !lastClosed || q.to > lastClosed, rows };
  });

  /** When each amortization's balance at `asOf` will be expensed, by month. */
  app.get('/api/accounting/reports/waterfall', async (req) => {
    const ps = await periods();
    const q = z.object({ asOf: ym.optional() }).parse(req.query ?? {});
    const asOf = q.asOf ?? ps[ps.length - 1]?.month ?? new Date().toISOString().slice(0, 7);
    const rows = (await bookedRows())
      .map((r) => {
        const a = toAsset(r);
        return { id: r.id, code: assetCode(r.number), name: assetName(r), origin: r.origin, payee: r.payee, department: r.department, typeName: r.typeName, balance: assetPosition(a, asOf).remaining, byMonth: futureAmortization(a, asOf) };
      })
      .filter((x) => x.balance !== 0);
    return { asOf, lastClosed: ps[ps.length - 1]?.month ?? null, rows };
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
