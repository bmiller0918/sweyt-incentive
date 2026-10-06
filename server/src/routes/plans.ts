import { makePlanLookup, planTiersSchema, type PlanLookup } from '@commissions/shared';
import { asc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { auditLog, compPlans, repPlanAssignments } from '../db/schema.js';

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

const assignmentSchema = z.object({
  repName: z.string().min(1),
  compPlanId: z.string().uuid(),
  effectiveFrom: dateStr,
  effectiveTo: dateStr,
});

/** Load every assignment joined to its plan and build the lookup used by stage 3. */
export async function loadPlanLookup(db: Db, asOf: string): Promise<PlanLookup> {
  const rows = await db
    .select({
      repName: repPlanAssignments.repName,
      effectiveFrom: repPlanAssignments.effectiveFrom,
      effectiveTo: repPlanAssignments.effectiveTo,
      planName: compPlans.name,
      params: compPlans.params,
      tiers: compPlans.tiers,
      planFrom: compPlans.effectiveFrom,
      planTo: compPlans.effectiveTo,
    })
    .from(repPlanAssignments)
    .innerJoin(compPlans, eq(repPlanAssignments.compPlanId, compPlans.id));
  // A plan's own effective window also bounds its assignments.
  const narrowed = rows.map((r) => ({
    repName: r.repName,
    planName: r.planName,
    params: r.params,
    tiers: r.tiers,
    effectiveFrom: [r.effectiveFrom, r.planFrom].filter(Boolean).sort().pop() ?? null,
    effectiveTo: [r.effectiveTo, r.planTo].filter(Boolean).sort().shift() ?? null,
  }));
  return makePlanLookup(narrowed, asOf);
}

export async function planRoutes(app: FastifyInstance, db: Db) {
  app.get('/api/comp-plans', async () => {
    const plans = await db.select().from(compPlans).orderBy(asc(compPlans.name));
    const counts = await db
      .select({ compPlanId: repPlanAssignments.compPlanId, n: sql<number>`count(*)::int` })
      .from(repPlanAssignments)
      .groupBy(repPlanAssignments.compPlanId);
    const byId = new Map(counts.map((c) => [c.compPlanId, c.n]));
    return plans.map((p) => ({ ...p, repCount: byId.get(p.id) ?? 0 }));
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

  // -- Assignments -----------------------------------------------------------
  app.get('/api/rep-assignments', async () => {
    return db
      .select({
        id: repPlanAssignments.id,
        repName: repPlanAssignments.repName,
        compPlanId: repPlanAssignments.compPlanId,
        planName: compPlans.name,
        effectiveFrom: repPlanAssignments.effectiveFrom,
        effectiveTo: repPlanAssignments.effectiveTo,
      })
      .from(repPlanAssignments)
      .innerJoin(compPlans, eq(repPlanAssignments.compPlanId, compPlans.id))
      .orderBy(asc(repPlanAssignments.repName));
  });

  app.post('/api/rep-assignments', async (req) => {
    const body = assignmentSchema.parse(req.body);
    const [row] = await db.insert(repPlanAssignments).values({ ...body, repName: body.repName.trim() }).returning();
    await db.insert(auditLog).values({ action: 'assignment.create', entityType: 'rep_plan_assignment', entityId: row.id });
    return row;
  });

  /** Assign many reps to one plan at once (skips names already on that plan). */
  const bulkSchema = z.object({ compPlanId: z.string().uuid(), repNames: z.array(z.string().min(1)), effectiveFrom: dateStr, effectiveTo: dateStr });
  app.post('/api/rep-assignments/bulk', async (req) => {
    const body = bulkSchema.parse(req.body);
    const existing = await db
      .select({ repName: repPlanAssignments.repName })
      .from(repPlanAssignments)
      .where(eq(repPlanAssignments.compPlanId, body.compPlanId));
    const have = new Set(existing.map((e) => e.repName.toLowerCase()));
    const names = [...new Set(body.repNames.map((n) => n.trim()).filter(Boolean))].filter((n) => !have.has(n.toLowerCase()));
    if (!names.length) return { created: 0 };
    await db.insert(repPlanAssignments).values(
      names.map((repName) => ({ repName, compPlanId: body.compPlanId, effectiveFrom: body.effectiveFrom ?? null, effectiveTo: body.effectiveTo ?? null })),
    );
    await db.insert(auditLog).values({ action: 'assignment.bulk', entityType: 'comp_plan', entityId: body.compPlanId, detail: { created: names.length } });
    return { created: names.length };
  });

  app.put('/api/rep-assignments/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = assignmentSchema.parse(req.body);
    const [row] = await db
      .update(repPlanAssignments)
      .set({ ...body, repName: body.repName.trim(), updatedAt: new Date() })
      .where(eq(repPlanAssignments.id, id))
      .returning();
    if (!row) return reply.code(404).send({ error: 'Assignment not found' });
    return row;
  });

  app.delete('/api/rep-assignments/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await db.delete(repPlanAssignments).where(eq(repPlanAssignments.id, id));
    return reply.code(204).send();
  });
}
