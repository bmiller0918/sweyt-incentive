import { BUILTIN_THRESHOLD_TYPES, makePlanLookup, planQuotasSchema, planStructureSchema, planTiersSchema, type EmployeeRecord, type PlanLookup, type PlanTiers } from '@commissions/shared';
import { asc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { calendar } from '../appSettings.js';
import type { Db } from '../db/client.js';
import { auditLog, compPlans, employeeTypes, employees, planAssignments, thresholdTypes, typePlanAssignments } from '../db/schema.js';

/** Make sure the built-in threshold types exist (idempotent). */
export async function seedThresholdTypes(db: Db) {
  const existing = new Set((await db.select({ key: thresholdTypes.key }).from(thresholdTypes)).map((r) => r.key));
  const missing = BUILTIN_THRESHOLD_TYPES.filter((t) => !existing.has(t.key));
  if (missing.length) await db.insert(thresholdTypes).values(missing.map((t) => ({ ...t, builtin: 1 })));
}

/** Attach each plan's threshold-type scaling so the engine needs no DB access. */
function resolveTiers(tiers: PlanTiers, types: Map<string, { scaleParam: string | null }>): PlanTiers {
  const t = types.get(tiers.basis);
  return { ...tiers, scaleParam: t ? t.scaleParam : tiers.basis === 'percent_of_quota' ? 'quota' : null };
}

const paramValue = z.union([z.number(), z.string(), z.boolean(), z.null()]);
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional();

const planSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  params: z.record(paramValue).default({}),
  tiers: planTiersSchema.default({ mode: 'marginal', basis: 'amount', scaleParam: null, rows: [] }),
  structure: planStructureSchema.default({ targetIncentive: null, components: [] }),
  employeeTypeId: z.string().uuid().nullable().optional(),
  quotas: planQuotasSchema.nullable().optional(),
  effectiveFrom: dateStr,
  effectiveTo: dateStr,
});

export const EMPLOYEE_STATUSES = ['active', 'terminated', 'parental_leave', 'medical_leave', 'leave', 'inactive'] as const;

const employeeTypeSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  defaultBaseSalary: z.number().nullable().optional(),
  defaultQuota: z.number().nullable().optional(),
  costTreatment: z.enum(['capitalize', 'expense']).default('capitalize'),
  amortizationTypeId: z.string().uuid().nullable().optional(),
});

const employeeSchema = z.object({
  name: z.string().min(1),
  title: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  employeeTypeId: z.string().uuid().nullable().optional(),
  baseSalary: z.number().nullable().optional(),
  quota: z.number().nullable().optional(),
  bonuses: z.array(z.object({ label: z.string().min(1), amount: z.number() })).default([]),
  notes: z.string().nullable().optional(),
  startDate: dateStr,
  status: z.enum(EMPLOYEE_STATUSES).default('active'),
  statusDate: dateStr,
});

const assignmentSchema = z.object({
  compPlanId: z.string().uuid(),
  slot: z.string().min(1).default('plan'),
  effectiveFrom: dateStr,
  effectiveTo: dateStr,
});

const planCols = {
  slot: sql<string>`slot`,
  planName: compPlans.name,
  params: compPlans.params,
  tiers: compPlans.tiers,
  structure: compPlans.structure,
  quotas: compPlans.quotas,
  planFrom: compPlans.effectiveFrom,
  planTo: compPlans.effectiveTo,
};

/** A plan's own effective window also bounds its assignments. */
function bounded(r: { effectiveFrom: string | null; effectiveTo: string | null; planFrom: string | null; planTo: string | null }) {
  return {
    effectiveFrom: [r.effectiveFrom, r.planFrom].filter(Boolean).sort().pop() ?? null,
    effectiveTo: [r.effectiveTo, r.planTo].filter(Boolean).sort().shift() ?? null,
  };
}

/** Load employees (+ type defaults) with their assignments and build the stage-3 lookup. */
export async function loadPlanLookup(db: Db, asOf: string): Promise<PlanLookup> {
  return makePlanLookup(await loadEmployeeRecords(db), asOf);
}

/** Employees (+ type defaults) with every assignment, own and inherited, for the engine. */
export async function loadEmployeeRecords(db: Db): Promise<EmployeeRecord[]> {
  const ttypes = new Map((await db.select().from(thresholdTypes)).map((t) => [t.key, { scaleParam: t.scaleParam }]));
  const emps = await db
    .select({ e: employees, typeName: employeeTypes.name, typeSalary: employeeTypes.defaultBaseSalary, typeQuota: employeeTypes.defaultQuota })
    .from(employees)
    .leftJoin(employeeTypes, eq(employees.employeeTypeId, employeeTypes.id));
  const own = await db
    .select({ ownerId: planAssignments.employeeId, effectiveFrom: planAssignments.effectiveFrom, effectiveTo: planAssignments.effectiveTo, ...planCols, slot: planAssignments.slot })
    .from(planAssignments)
    .innerJoin(compPlans, eq(planAssignments.compPlanId, compPlans.id));
  const inherited = await db
    .select({ ownerId: typePlanAssignments.employeeTypeId, effectiveFrom: typePlanAssignments.effectiveFrom, effectiveTo: typePlanAssignments.effectiveTo, ...planCols, slot: typePlanAssignments.slot })
    .from(typePlanAssignments)
    .innerJoin(compPlans, eq(typePlanAssignments.compPlanId, compPlans.id));

  const group = <T extends { ownerId: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) m.set(r.ownerId, [...(m.get(r.ownerId) ?? []), r]);
    return m;
  };
  const ownBy = group(own);
  const typeBy = group(inherited);

  return emps.map(({ e, typeName, typeSalary, typeQuota }) => ({
    name: e.name,
    status: e.status,
    type: typeName,
    baseSalary: e.baseSalary ?? typeSalary ?? null,
    quota: e.quota ?? typeQuota ?? null,
    bonuses: Object.fromEntries(e.bonuses.map((b) => [b.label, b.amount])),
    assignments: [
      ...(ownBy.get(e.id) ?? []).map((r) => ({ source: 'employee' as const, slot: r.slot, planName: r.planName, params: r.params, tiers: resolveTiers(r.tiers, ttypes), structure: r.structure, quotas: r.quotas, ...bounded(r) })),
      ...(e.employeeTypeId ? (typeBy.get(e.employeeTypeId) ?? []) : []).map((r) => ({ source: 'type' as const, slot: r.slot, planName: r.planName, params: r.params, tiers: resolveTiers(r.tiers, ttypes), structure: r.structure, quotas: r.quotas, ...bounded(r) })),
    ],
  }));
}

export async function planRoutes(app: FastifyInstance, db: Db) {
  await seedThresholdTypes(db);

  /** Settings the client needs to resolve periods the same way the server does. */
  app.get('/api/config', async () => calendar());

  // -- Threshold types -------------------------------------------------------
  app.get('/api/threshold-types', async () => db.select().from(thresholdTypes).orderBy(asc(thresholdTypes.builtin), asc(thresholdTypes.name)));

  const thresholdTypeSchema = z.object({
    name: z.string().min(1),
    unit: z.string().default(''),
    scaleParam: z.string().nullable().optional(),
  });
  app.post('/api/threshold-types', async (req, reply) => {
    const body = thresholdTypeSchema.parse(req.body);
    const key = body.name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    if (!key) return reply.code(400).send({ error: 'Name must contain letters or digits' });
    const [dupe] = await db.select({ id: thresholdTypes.id }).from(thresholdTypes).where(eq(thresholdTypes.key, key));
    if (dupe) return reply.code(409).send({ error: `A threshold type "${body.name}" already exists` });
    const [row] = await db
      .insert(thresholdTypes)
      .values({ key, name: body.name.trim(), unit: body.unit.trim(), scaleParam: body.scaleParam?.trim() || null })
      .returning();
    await db.insert(auditLog).values({ action: 'threshold_type.create', entityType: 'threshold_type', entityId: row.id });
    return row;
  });

  app.delete('/api/threshold-types/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [row] = await db.select().from(thresholdTypes).where(eq(thresholdTypes.id, id));
    if (!row) return reply.code(404).send({ error: 'Not found' });
    if (row.builtin) return reply.code(400).send({ error: 'Built-in threshold types cannot be deleted' });
    await db.delete(thresholdTypes).where(eq(thresholdTypes.id, id));
    return reply.code(204).send();
  });

  // -- Comp plans ------------------------------------------------------------
  app.get('/api/comp-plans', async () => {
    const plans = await db.select().from(compPlans).orderBy(asc(compPlans.name));
    const counts = await db
      .select({ compPlanId: planAssignments.compPlanId, n: sql<number>`count(distinct ${planAssignments.employeeId})::int` })
      .from(planAssignments)
      .groupBy(planAssignments.compPlanId);
    const byId = new Map(counts.map((c) => [c.compPlanId, c.n]));
    return plans.map((p) => ({ ...p, employeeCount: byId.get(p.id) ?? 0 }));
  });

  app.post('/api/comp-plans', async (req) => {
    const body = planSchema.parse(req.body);
    const [row] = await db.insert(compPlans).values(body).returning();
    await db.insert(auditLog).values({ action: 'plan.create', entityType: 'comp_plan', entityId: row.id });
    return row;
  });

  app.put('/api/comp-plans/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = planSchema.parse(req.body);
    const [row] = await db
      .update(compPlans)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(compPlans.id, id))
      .returning();
    if (!row) return reply.code(404).send({ error: 'Plan not found' });
    await db.insert(auditLog).values({ action: 'plan.update', entityType: 'comp_plan', entityId: id });
    return row;
  });

  app.delete('/api/comp-plans/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await db.delete(compPlans).where(eq(compPlans.id, id));
    await db.insert(auditLog).values({ action: 'plan.delete', entityType: 'comp_plan', entityId: id });
    return reply.code(204).send();
  });

  // -- Employee types --------------------------------------------------------
  const typeAssignmentRows = () =>
    db
      .select({
        id: typePlanAssignments.id,
        employeeTypeId: typePlanAssignments.employeeTypeId,
        compPlanId: typePlanAssignments.compPlanId,
        planName: compPlans.name,
        slot: typePlanAssignments.slot,
        effectiveFrom: typePlanAssignments.effectiveFrom,
        effectiveTo: typePlanAssignments.effectiveTo,
      })
      .from(typePlanAssignments)
      .innerJoin(compPlans, eq(typePlanAssignments.compPlanId, compPlans.id));

  const typesWithAssignments = async () => {
    const types = await db.select().from(employeeTypes).orderBy(asc(employeeTypes.name));
    const rows = await typeAssignmentRows();
    const counts = await db.select({ typeId: employees.employeeTypeId, n: sql<number>`count(*)::int` }).from(employees).groupBy(employees.employeeTypeId);
    const countBy = new Map(counts.map((c) => [c.typeId, c.n]));
    return types.map((t) => ({
      ...t,
      employeeCount: countBy.get(t.id) ?? 0,
      assignments: rows.filter((r) => r.employeeTypeId === t.id).sort((a, b) => a.slot.localeCompare(b.slot)),
    }));
  };

  app.get('/api/employee-types', async () => typesWithAssignments());

  app.post('/api/employee-types', async (req) => {
    const body = employeeTypeSchema.parse(req.body);
    const [row] = await db.insert(employeeTypes).values(body).returning();
    await db.insert(auditLog).values({ action: 'employee_type.create', entityType: 'employee_type', entityId: row.id });
    return (await typesWithAssignments()).find((t) => t.id === row.id);
  });

  app.put('/api/employee-types/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = employeeTypeSchema.parse(req.body);
    const [row] = await db
      .update(employeeTypes)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(employeeTypes.id, id))
      .returning();
    if (!row) return reply.code(404).send({ error: 'Employee type not found' });
    await db.insert(auditLog).values({ action: 'employee_type.update', entityType: 'employee_type', entityId: id });
    return (await typesWithAssignments()).find((t) => t.id === id);
  });

  app.delete('/api/employee-types/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await db.delete(employeeTypes).where(eq(employeeTypes.id, id));
    await db.insert(auditLog).values({ action: 'employee_type.delete', entityType: 'employee_type', entityId: id });
    return reply.code(204).send();
  });

  app.post('/api/employee-types/:id/assignments', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = assignmentSchema.parse(req.body);
    const [t] = await db.select({ id: employeeTypes.id }).from(employeeTypes).where(eq(employeeTypes.id, id));
    if (!t) return reply.code(404).send({ error: 'Employee type not found' });
    const [row] = await db.insert(typePlanAssignments).values({ ...body, employeeTypeId: id, slot: body.slot.trim().toLowerCase() }).returning();
    return row;
  });

  app.put('/api/type-assignments/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = assignmentSchema.parse(req.body);
    const [row] = await db
      .update(typePlanAssignments)
      .set({ ...body, slot: body.slot.trim().toLowerCase(), updatedAt: new Date() })
      .where(eq(typePlanAssignments.id, id))
      .returning();
    if (!row) return reply.code(404).send({ error: 'Assignment not found' });
    return row;
  });

  app.delete('/api/type-assignments/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await db.delete(typePlanAssignments).where(eq(typePlanAssignments.id, id));
    return reply.code(204).send();
  });

  // -- Employees -------------------------------------------------------------
  const withAssignments = async (ids?: string[]) => {
    const emps = ids
      ? await db
          .select({ e: employees, typeName: employeeTypes.name })
          .from(employees)
          .leftJoin(employeeTypes, eq(employees.employeeTypeId, employeeTypes.id))
          .where(sql`${employees.id} in ${ids}`)
      : await db
          .select({ e: employees, typeName: employeeTypes.name })
          .from(employees)
          .leftJoin(employeeTypes, eq(employees.employeeTypeId, employeeTypes.id))
          .orderBy(asc(employees.name));
    const rows = await db
      .select({
        id: planAssignments.id,
        employeeId: planAssignments.employeeId,
        compPlanId: planAssignments.compPlanId,
        planName: compPlans.name,
        slot: planAssignments.slot,
        effectiveFrom: planAssignments.effectiveFrom,
        effectiveTo: planAssignments.effectiveTo,
      })
      .from(planAssignments)
      .innerJoin(compPlans, eq(planAssignments.compPlanId, compPlans.id));
    const typeRows = await typeAssignmentRows();
    const byEmp = new Map<string, typeof rows>();
    for (const r of rows) byEmp.set(r.employeeId, [...(byEmp.get(r.employeeId) ?? []), r]);
    return emps.map(({ e, typeName }) => ({
      ...e,
      typeName,
      assignments: (byEmp.get(e.id) ?? []).sort((a, b) => a.slot.localeCompare(b.slot)),
      /** Read-only view of what the type contributes. */
      inherited: e.employeeTypeId ? typeRows.filter((r) => r.employeeTypeId === e.employeeTypeId).sort((a, b) => a.slot.localeCompare(b.slot)) : [],
    }));
  };

  app.get('/api/employees', async () => withAssignments());

  app.post('/api/employees', async (req) => {
    const body = employeeSchema.parse(req.body);
    const [row] = await db.insert(employees).values({ ...body, name: body.name.trim() }).returning();
    await db.insert(auditLog).values({ action: 'employee.create', entityType: 'employee', entityId: row.id });
    return (await withAssignments([row.id]))[0];
  });

  /** Create many employees by name (skips names that already exist, case-insensitively). */
  const bulkSchema = z.object({ names: z.array(z.string().min(1)), employeeTypeId: z.string().uuid().nullable().optional() });
  app.post('/api/employees/bulk', async (req) => {
    const body = bulkSchema.parse(req.body);
    const existing = await db.select({ name: employees.name }).from(employees);
    const have = new Set(existing.map((e) => e.name.trim().toLowerCase()));
    const names = [...new Set(body.names.map((n) => n.trim()).filter(Boolean))].filter((n) => !have.has(n.toLowerCase()));
    if (!names.length) return { created: 0 };
    await db.insert(employees).values(names.map((name) => ({ name, employeeTypeId: body.employeeTypeId ?? null })));
    await db.insert(auditLog).values({ action: 'employee.bulk', entityType: 'employee', detail: { created: names.length } });
    return { created: names.length };
  });

  app.put('/api/employees/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = employeeSchema.parse(req.body);
    const [row] = await db
      .update(employees)
      .set({ ...body, name: body.name.trim(), updatedAt: new Date() })
      .where(eq(employees.id, id))
      .returning();
    if (!row) return reply.code(404).send({ error: 'Employee not found' });
    await db.insert(auditLog).values({ action: 'employee.update', entityType: 'employee', entityId: id });
    return (await withAssignments([id]))[0];
  });

  app.delete('/api/employees/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await db.delete(employees).where(eq(employees.id, id));
    await db.insert(auditLog).values({ action: 'employee.delete', entityType: 'employee', entityId: id });
    return reply.code(204).send();
  });

  // -- Plan assignments ------------------------------------------------------
  app.post('/api/employees/:id/assignments', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = assignmentSchema.parse(req.body);
    const [emp] = await db.select({ id: employees.id }).from(employees).where(eq(employees.id, id));
    if (!emp) return reply.code(404).send({ error: 'Employee not found' });
    const [row] = await db.insert(planAssignments).values({ ...body, employeeId: id, slot: body.slot.trim().toLowerCase() }).returning();
    await db.insert(auditLog).values({ action: 'assignment.create', entityType: 'plan_assignment', entityId: row.id });
    return row;
  });

  app.put('/api/assignments/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = assignmentSchema.parse(req.body);
    const [row] = await db
      .update(planAssignments)
      .set({ ...body, slot: body.slot.trim().toLowerCase(), updatedAt: new Date() })
      .where(eq(planAssignments.id, id))
      .returning();
    if (!row) return reply.code(404).send({ error: 'Assignment not found' });
    return row;
  });

  app.delete('/api/assignments/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await db.delete(planAssignments).where(eq(planAssignments.id, id));
    return reply.code(204).send();
  });
}
