import { criteriaSchema } from '@commissions/shared';
import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { auditLog, criteriaSets, criteriaVersions, imports } from '../db/schema.js';

const upsertSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  importId: z.string().uuid().nullable().optional(),
  criteria: criteriaSchema,
});

export async function criteriaRoutes(app: FastifyInstance, db: Db) {
  app.get('/api/criteria-sets', async (req) => {
    const { importId } = req.query as { importId?: string };
    const rows = await db
      .select({
        id: criteriaSets.id,
        name: criteriaSets.name,
        description: criteriaSets.description,
        importId: criteriaSets.importId,
        importName: imports.name,
        criteria: criteriaSets.criteria,
        version: criteriaSets.version,
        createdAt: criteriaSets.createdAt,
        updatedAt: criteriaSets.updatedAt,
      })
      .from(criteriaSets)
      .leftJoin(imports, eq(criteriaSets.importId, imports.id))
      .orderBy(desc(criteriaSets.updatedAt));
    // Show sets for this import plus any not tied to an import.
    return importId ? rows.filter((r) => !r.importId || r.importId === importId) : rows;
  });

  app.get('/api/criteria-sets/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [row] = await db.select().from(criteriaSets).where(eq(criteriaSets.id, id));
    if (!row) return reply.code(404).send({ error: 'Not found' });
    return row;
  });

  app.get('/api/criteria-sets/:id/versions', async (req) => {
    const { id } = req.params as { id: string };
    return db.select().from(criteriaVersions).where(eq(criteriaVersions.criteriaSetId, id)).orderBy(desc(criteriaVersions.version));
  });

  app.post('/api/criteria-sets', async (req) => {
    const body = upsertSchema.parse(req.body);
    const [row] = await db
      .insert(criteriaSets)
      .values({ name: body.name, description: body.description, importId: body.importId ?? null, criteria: body.criteria, version: 1 })
      .returning();
    await db.insert(criteriaVersions).values({ criteriaSetId: row.id, version: 1, criteria: body.criteria });
    await db.insert(auditLog).values({ action: 'criteria.create', entityType: 'criteria_set', entityId: row.id });
    return row;
  });

  app.put('/api/criteria-sets/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = upsertSchema.parse(req.body);
    const [current] = await db.select().from(criteriaSets).where(eq(criteriaSets.id, id));
    if (!current) return reply.code(404).send({ error: 'Not found' });
    const changed = JSON.stringify(current.criteria) !== JSON.stringify(body.criteria);
    const version = changed ? current.version + 1 : current.version;
    const [row] = await db
      .update(criteriaSets)
      .set({ name: body.name, description: body.description, criteria: body.criteria, version, updatedAt: new Date() })
      .where(eq(criteriaSets.id, id))
      .returning();
    if (changed) await db.insert(criteriaVersions).values({ criteriaSetId: id, version, criteria: body.criteria });
    await db.insert(auditLog).values({ action: 'criteria.update', entityType: 'criteria_set', entityId: id, detail: { version } });
    return row;
  });

  app.delete('/api/criteria-sets/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await db.delete(criteriaSets).where(eq(criteriaSets.id, id));
    await db.insert(auditLog).values({ action: 'criteria.delete', entityType: 'criteria_set', entityId: id });
    return reply.code(204).send();
  });
}
