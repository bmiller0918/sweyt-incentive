// Commission payroll templates: one per employee type, saying who is credited
// on each deal (their own deals, or all deals) and which columns a run reads.
// Runs apply them to an import on the Commission Payroll screen.
import { payrollTemplateDefinitionSchema } from '@commissions/shared';
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { auditLog, payrollTemplates } from '../db/schema.js';

const templateSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().nullable().optional(),
  employeeTypeId: z.string().uuid().nullable().optional(),
  definition: payrollTemplateDefinitionSchema,
});

export async function payrollTemplateRoutes(app: FastifyInstance, db: Db) {
  app.get('/api/payroll-templates', async () => db.select().from(payrollTemplates).orderBy(asc(payrollTemplates.name)));

  app.post('/api/payroll-templates', async (req) => {
    const body = templateSchema.parse(req.body);
    const [row] = await db
      .insert(payrollTemplates)
      .values({ ...body, description: body.description ?? null, employeeTypeId: body.employeeTypeId ?? null })
      .returning();
    await db.insert(auditLog).values({ action: 'payroll_template.create', entityType: 'payroll_template', entityId: row.id });
    return row;
  });

  app.put('/api/payroll-templates/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = templateSchema.parse(req.body);
    const [row] = await db
      .update(payrollTemplates)
      .set({ ...body, description: body.description ?? null, employeeTypeId: body.employeeTypeId ?? null, updatedAt: new Date() })
      .where(eq(payrollTemplates.id, id))
      .returning();
    if (!row) return reply.code(404).send({ error: 'Template not found' });
    await db.insert(auditLog).values({ action: 'payroll_template.update', entityType: 'payroll_template', entityId: id });
    return row;
  });

  app.delete('/api/payroll-templates/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await db.delete(payrollTemplates).where(eq(payrollTemplates.id, id));
    await db.insert(auditLog).values({ action: 'payroll_template.delete', entityType: 'payroll_template', entityId: id });
    return reply.code(204).send();
  });
}
