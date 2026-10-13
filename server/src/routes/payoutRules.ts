// Payout rules: workspace-wide field + operator + value checks, in the spirit
// of a cross-validation rule. Every commission run applies them to its deals;
// a deal that fails a check starts on hold with the rule's reason, and the
// Payout Rules page can test the rules against any import before a run.
import { applyPayoutRules, conditionSchema, payoutRuleSchema, requirementSchema, type ColumnType, type Condition, type PayoutRule, type Requirement } from '@commissions/shared';
import { asc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import type { Db } from '../db/client.js';
import { auditLog, holdReasons, imports, payoutRules } from '../db/schema.js';
import { getRows } from '../rowcache.js';

type Row = typeof payoutRules.$inferSelect;

/** The engine's shape, from a stored row. */
export const toPayoutRule = (r: Row): PayoutRule => ({
  id: r.id,
  name: r.name,
  message: r.message,
  reasonKey: r.reasonKey,
  filters: r.filters,
  requirements: r.requirements,
  requireAll: r.requireAll === 1,
  enabled: r.enabled === 1,
});

/** Every enabled rule, in order, ready for the engine. */
export async function loadPayoutRules(db: Db): Promise<PayoutRule[]> {
  const rows = await db.select().from(payoutRules).orderBy(asc(payoutRules.sortOrder), asc(payoutRules.createdAt));
  return rows.map(toPayoutRule).filter((r) => r.enabled);
}

export const evalContext = () => ({ fiscalYearStartMonth: config.fiscalYearStartMonth, weekStartsOn: config.weekStartsOn });

const ruleInput = z.object({
  name: z.string().default(''),
  message: z.string().default(''),
  reasonKey: z.string().min(1),
  filters: z.array(conditionSchema).default([]),
  requirements: z.array(requirementSchema).default([]),
  requireAll: z.boolean().default(true),
  enabled: z.boolean().default(true),
});

/** The stored shape of a validated rule body. */
const toValues = (body: z.infer<typeof ruleInput>) => ({
  name: body.name.trim(),
  message: body.message.trim(),
  reasonKey: body.reasonKey,
  filters: body.filters as Condition[],
  requirements: body.requirements as Requirement[],
  requireAll: body.requireAll ? 1 : 0,
  enabled: body.enabled ? 1 : 0,
});

export async function payoutRuleRoutes(app: FastifyInstance, db: Db) {
  const list = () => db.select().from(payoutRules).orderBy(asc(payoutRules.sortOrder), asc(payoutRules.createdAt));

  const checkReason = async (key: string) => {
    const [r] = await db.select({ id: holdReasons.id }).from(holdReasons).where(eq(holdReasons.key, key));
    return !!r;
  };

  app.get('/api/payout-rules', async () => (await list()).map((r) => ({ ...toPayoutRule(r), sortOrder: r.sortOrder, updatedAt: r.updatedAt })));

  /**
   * Fields a rule can name: the union of column headers across every import,
   * with the type most imports give that header. Rules are matched to data by
   * header name, so one rule serves every file with that column.
   */
  app.get('/api/payout-rules/fields', async () => {
    const imps = await db.select({ name: imports.name, columns: imports.columns }).from(imports);
    const byName = new Map<string, { types: Map<ColumnType, number>; imports: string[] }>();
    for (const imp of imps) {
      for (const c of imp.columns) {
        const e = byName.get(c.name) ?? { types: new Map<ColumnType, number>(), imports: [] as string[] };
        e.types.set(c.type, (e.types.get(c.type) ?? 0) + 1);
        e.imports.push(imp.name);
        byName.set(c.name, e);
      }
    }
    return [...byName.entries()]
      .map(([name, e]) => ({ name, type: [...e.types.entries()].sort((a, b) => b[1] - a[1])[0][0], imports: e.imports }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  app.post('/api/payout-rules', async (req, reply) => {
    const body = ruleInput.parse(req.body);
    if (!(await checkReason(body.reasonKey))) return reply.code(400).send({ error: `Unknown hold reason "${body.reasonKey}"` });
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(payoutRules);
    const [row] = await db
      .insert(payoutRules)
      .values({ ...toValues(body), sortOrder: n })
      .returning();
    await db.insert(auditLog).values({ action: 'payout_rule.create', entityType: 'payout_rule', entityId: row.id, detail: body });
    return { ...toPayoutRule(row), sortOrder: row.sortOrder, updatedAt: row.updatedAt };
  });

  app.put('/api/payout-rules/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = ruleInput.parse(req.body);
    if (!(await checkReason(body.reasonKey))) return reply.code(400).send({ error: `Unknown hold reason "${body.reasonKey}"` });
    const [row] = await db
      .update(payoutRules)
      .set({ ...toValues(body), updatedAt: new Date() })
      .where(eq(payoutRules.id, id))
      .returning();
    if (!row) return reply.code(404).send({ error: 'Rule not found' });
    await db.insert(auditLog).values({ action: 'payout_rule.update', entityType: 'payout_rule', entityId: id, detail: body });
    return { ...toPayoutRule(row), sortOrder: row.sortOrder, updatedAt: row.updatedAt };
  });

  /** Rules apply in order (the first rule that flags a deal gives the reason), so order is editable. */
  app.put('/api/payout-rules/order', async (req, reply) => {
    const { ids } = z.object({ ids: z.array(z.string().uuid()) }).parse(req.body);
    const existing = new Set((await list()).map((r) => r.id));
    if (ids.length !== existing.size || ids.some((id) => !existing.has(id))) return reply.code(400).send({ error: 'Order must list every rule exactly once' });
    for (let i = 0; i < ids.length; i++) await db.update(payoutRules).set({ sortOrder: i }).where(eq(payoutRules.id, ids[i]));
    return (await list()).map((r) => ({ ...toPayoutRule(r), sortOrder: r.sortOrder, updatedAt: r.updatedAt }));
  });

  app.delete('/api/payout-rules/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const deleted = await db.delete(payoutRules).where(eq(payoutRules.id, id)).returning({ id: payoutRules.id });
    if (!deleted.length) return reply.code(404).send({ error: 'Rule not found' });
    await db.insert(auditLog).values({ action: 'payout_rule.delete', entityType: 'payout_rule', entityId: id });
    return reply.code(204).send();
  });

  /**
   * Dry run: evaluate the rules (saved ones, or a draft set passed in) against
   * an import. Returns how many rows each rule flags, which rules couldn't
   * run, and the flagged rows themselves so they can be reviewed.
   */
  const previewSchema = z.object({ importId: z.string().uuid(), rules: z.array(payoutRuleSchema).optional(), limit: z.number().int().min(1).max(1000).default(200) });
  app.post('/api/payout-rules/preview', async (req, reply) => {
    const body = previewSchema.parse(req.body);
    const [imp] = await db.select().from(imports).where(eq(imports.id, body.importId));
    if (!imp) return reply.code(404).send({ error: 'Import not found' });
    const rules = body.rules ?? (await list()).map(toPayoutRule);
    const cached = await getRows(db, imp);
    const res = applyPayoutRules(cached.typed, rules, { types: cached.types, ...evalContext() });
    const flagged: { index: number; ruleIds: string[]; data: Record<string, string> }[] = [];
    // The limit applies per rule: the editor shows the rows for one rule at a
    // time, so every rule gets up to `limit` of its rows even when earlier
    // rules flag thousands.
    const shown: Record<string, number> = {};
    let flaggedCount = 0;
    res.allHits.forEach((ids, i) => {
      if (!ids.length) return;
      flaggedCount++;
      if (!ids.some((id) => (shown[id] ?? 0) < body.limit)) return;
      for (const id of ids) shown[id] = (shown[id] ?? 0) + 1;
      flagged.push({ index: i, ruleIds: ids, data: cached.raw[i] });
    });
    return { total: cached.typed.length, flaggedCount, counts: res.counts, errors: res.errors, skipped: res.skipped, columns: cached.columns, rows: flagged };
  });
}
