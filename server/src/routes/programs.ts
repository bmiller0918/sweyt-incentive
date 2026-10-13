// Spiffs, accelerators and bonuses: incentive programs that pay on a metric
// from any import, for a window, beside the annual comp plan. Commission runs
// pay every enabled program whose window overlaps the run (see
// programLinesForRun); the preview endpoint shows what one would pay.
import { PROGRAM_KINDS, computeProgramLines, payeeTotals, programDefinitionSchema, type CommissionLine } from '@commissions/shared';
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { auditLog, employeeTypes, employees, imports, incentivePrograms } from '../db/schema.js';
import { getRows } from '../rowcache.js';
import { evalContext } from './payoutRules.js';

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional();

const programSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  kind: z.enum(PROGRAM_KINDS),
  enabled: z.boolean().default(true),
  importId: z.string().uuid().nullable().optional(),
  employeeTypeIds: z.array(z.string().uuid()).default([]),
  effectiveFrom: dateStr,
  effectiveTo: dateStr,
  definition: programDefinitionSchema,
});
type ProgramBody = z.infer<typeof programSchema>;

/** Employees by lower-cased name, with their type name, for eligibility. */
async function employeeIndex(db: Db) {
  const rows = await db.select({ name: employees.name, type: employeeTypes.name }).from(employees).leftJoin(employeeTypes, eq(employees.employeeTypeId, employeeTypes.id));
  const byName = new Map(rows.map((r) => [r.name.trim().toLowerCase(), { name: r.name, type: r.type }]));
  return (name: string) => byName.get(name.trim().toLowerCase()) ?? null;
}

/** Lines one program pays, optionally bounded by a run's window. */
async function linesFor(db: Db, p: ProgramBody, window: { from?: string | null; to?: string | null }, ctx: { employee: (n: string) => { name: string; type: string | null } | null; typeNames: Map<string, string> }) {
  if (!p.importId) return { lines: [] as CommissionLine[], warnings: [`${p.name}: pick the import its metric comes from.`] };
  const [imp] = await db.select().from(imports).where(eq(imports.id, p.importId));
  if (!imp) return { lines: [] as CommissionLine[], warnings: [`${p.name}: its import was deleted.`] };
  const cached = await getRows(db, imp);
  return computeProgramLines(
    {
      name: p.name,
      kind: p.kind,
      effectiveFrom: p.effectiveFrom ?? null,
      effectiveTo: p.effectiveTo ?? null,
      employeeTypes: p.employeeTypeIds.map((id) => ctx.typeNames.get(id)).filter((n): n is string => !!n),
      definition: p.definition,
    },
    { raw: cached.raw, typed: cached.typed, ctx: { types: cached.types, ...evalContext() } },
    { ...window, employee: ctx.employee },
  );
}

async function context(db: Db) {
  const typeNames = new Map((await db.select({ id: employeeTypes.id, name: employeeTypes.name }).from(employeeTypes)).map((t) => [t.id, t.name]));
  return { employee: await employeeIndex(db), typeNames };
}

/** Lines from every enabled program for a commission run's window. */
export async function programLinesForRun(db: Db, window: { from: string | null; to: string | null }) {
  const programs = await db.select().from(incentivePrograms).where(eq(incentivePrograms.enabled, true)).orderBy(asc(incentivePrograms.name));
  if (!programs.length) return { lines: [] as CommissionLine[], warnings: [] as string[] };
  const ctx = await context(db);
  const lines: CommissionLine[] = [];
  const warnings: string[] = [];
  for (const p of programs) {
    const parsed = programSchema.safeParse(p);
    if (!parsed.success) {
      warnings.push(`${p.name}: its settings could not be read, so it paid nothing.`);
      continue;
    }
    const res = await linesFor(db, parsed.data, window, ctx);
    lines.push(...res.lines);
    warnings.push(...res.warnings);
  }
  return { lines, warnings };
}

export async function programRoutes(app: FastifyInstance, db: Db) {
  app.get('/api/incentive-programs', async () => db.select().from(incentivePrograms).orderBy(asc(incentivePrograms.kind), asc(incentivePrograms.name)));

  app.post('/api/incentive-programs', async (req) => {
    const body = programSchema.parse(req.body);
    const [row] = await db.insert(incentivePrograms).values(body).returning();
    await db.insert(auditLog).values({ action: 'program.create', entityType: 'incentive_program', entityId: row.id });
    return row;
  });

  app.put('/api/incentive-programs/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = programSchema.parse(req.body);
    const [row] = await db
      .update(incentivePrograms)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(incentivePrograms.id, id))
      .returning();
    if (!row) return reply.code(404).send({ error: 'Program not found' });
    await db.insert(auditLog).values({ action: 'program.update', entityType: 'incentive_program', entityId: id });
    return row;
  });

  app.delete('/api/incentive-programs/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await db.delete(incentivePrograms).where(eq(incentivePrograms.id, id));
    await db.insert(auditLog).values({ action: 'program.delete', entityType: 'incentive_program', entityId: id });
    return reply.code(204).send();
  });

  /** What a (possibly unsaved) program would pay over its whole window. */
  app.post('/api/incentive-programs/preview', async (req) => {
    const body = programSchema.parse(req.body);
    const res = await linesFor(db, body, {}, await context(db));
    return { lines: res.lines, totals: payeeTotals(res.lines), totalPayout: res.lines.reduce((a, l) => a + (l.payout ?? 0), 0), warnings: res.warnings };
  });
}
