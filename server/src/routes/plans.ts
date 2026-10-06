import { makePlanLookup, planTiersSchema, type EmployeeRecord, type PlanLookup } from '@commissions/shared';
import { asc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { auditLog, compPlans, employees, planAssignments } from '../db/schema.js';

const paramValue = z.union([z.number(), z.string(), z.boolean(), z.null()]);
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional();

const planSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  params: z.record(paramValue).default({}),
  tiers: planTiersSchema.default({ mode: 'marginal', basis: 'amount', rows: [] }),
  effectiveFrom: dateStr,
  effectiveTo: dateStr,
});

export const EMPLOYEE_STATUSES = ['active', 'terminated', 'parental_leave', 'medical_leave', 'leave', 'inactive'] as const;

const employeeSchema = z.object({
  name: z.string().min(1),
  title: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  baseSalary: z.number().nullable().optional(),
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

/** Load employees with their assignments + plans and build the stage-3 lookup. */
export async function loadPlanLookup(db: Db, asOf: string): Promise<PlanLookup> {
  const emps = await db.select().from(employees);
  const rows = await db
    .select({
      employeeId: planAssignments.employeeId,
      slot: planAssignments.slot,
      effectiveFrom: planAssignments.effectiveFrom,
      effectiveTo: planAssignments.effectiveTo,
      planName: compPlans.name,
      params: compPlans.params,
      tiers: compPlans.tiers,
      planFrom: compPlans.effectiveFrom,
      planTo: compPlans.effectiveTo,
    })
    .from(planAssignments)
    .innerJoin(compPlans, eq(planAssignments.compPlanId, compPlans.id));
  const byEmployee = new Map<string, EmployeeRecord['assignments']>();
  for (const r of rows) {
    const list = byEmployee.get(r.employeeId) ?? [];
    // A plan's own effective window also bounds its assignments.
    list.push({
      slot: r.slot,
      planName: r.planName,
      params: r.params,
      tiers: r.tiers,
      effectiveFrom: [r.effectiveFrom, r.planFrom].filter(Boolean).sort().pop() ?? null,
      effectiveTo: [r.effectiveTo, r.planTo].filter(Boolean).sort().shift() ?? null,
    });
    byEmployee.set(r.employeeId, list);
  }
  const records: EmployeeRecord[] = emps.map((e) => ({
    name: e.name,
    status: e.status,
    baseSalary: e.baseSalary,
    bonuses: Object.fromEntries(e.bonuses.map((b) => [b.label, b.amount])),
    assignments: byEmployee.get(e.id) ?? [],
  }));
  return makePlanLookup(records, asOf);
}

export async function planRoutes(app: FastifyInstance, db: Db) {
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

  // -- Employees -------------------------------------------------------------
  const withAssignments = async (ids?: string[]) => {
    const emps = ids ? await db.select().from(employees).where(sql`${employees.id} in ${ids}`) : await db.select().from(employees).orderBy(asc(employees.name));
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
    const byEmp = new Map<string, typeof rows>();
    for (const r of rows) byEmp.set(r.employeeId, [...(byEmp.get(r.employeeId) ?? []), r]);
    return emps.map((e) => ({ ...e, assignments: (byEmp.get(e.id) ?? []).sort((a, b) => a.slot.localeCompare(b.slot)) }));
  };

  app.get('/api/employees', async () => withAssignments());

  app.post('/api/employees', async (req) => {
    const body = employeeSchema.parse(req.body);
    const [row] = await db.insert(employees).values({ ...body, name: body.name.trim() }).returning();
    await db.insert(auditLog).values({ action: 'employee.create', entityType: 'employee', entityId: row.id });
    return (await withAssignments([row.id]))[0];
  });

  /** Create many employees by name (skips names that already exist, case-insensitively). */
  const bulkSchema = z.object({ names: z.array(z.string().min(1)) });
  app.post('/api/employees/bulk', async (req) => {
    const body = bulkSchema.parse(req.body);
    const existing = await db.select({ name: employees.name }).from(employees);
    const have = new Set(existing.map((e) => e.name.trim().toLowerCase()));
    const names = [...new Set(body.names.map((n) => n.trim()).filter(Boolean))].filter((n) => !have.has(n.toLowerCase()));
    if (!names.length) return { created: 0 };
    await db.insert(employees).values(names.map((name) => ({ name })));
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
