// The Setup page: global settings, workspace usage (Licensing), system
// info (Manage Upgrades) and the import templates (Import Tools), plus the
// hook that enforces "Restrict feature permissions" on non-admins.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PERMISSIONS } from '@commissions/shared';
import { sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getAppSettings, saveAppSettings } from '../appSettings.js';
import { migrationsFolder, type Db } from '../db/client.js';
import { accountingPeriods, amortizationAssets, auditLog, commissionLines, commissionRuns, compPlans, criteriaSets, employeeTypes, employees, imports, users } from '../db/schema.js';
import { permissionFor } from '../permissions.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const startedAt = new Date().toISOString();

/** The server's package.json, from src/routes (tsx) or from the bundled dist/index.js. */
function readVersion(): string {
  for (const p of [path.resolve(here, '../../package.json'), path.resolve(here, '../package.json')]) {
    try {
      const pkg = JSON.parse(fs.readFileSync(p, 'utf8')) as { name?: string; version?: string };
      if (pkg.name === '@commissions/server' && pkg.version) return pkg.version;
    } catch {
      /* try the next one */
    }
  }
  return 'unknown';
}

/** The migration journal: how many migrations ship with this build and the latest one's tag. */
function readJournal(): { count: number; latest: string | null } {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(migrationsFolder(), 'meta/_journal.json'), 'utf8')) as { entries?: { tag: string }[] };
    const entries = j.entries ?? [];
    return { count: entries.length, latest: entries.length ? entries[entries.length - 1].tag : null };
  } catch {
    return { count: 0, latest: null };
  }
}

/** CSV templates for the Import Tools tab. */
const TEMPLATES: Record<string, { filename: string; rows: string[][] }> = {
  deals: {
    filename: 'deals-import-template.csv',
    rows: [
      ['Deal ID', 'Rep', 'SE', 'BDR', 'Manager', 'Customer', 'Amount', 'Close Date', 'Subscription Start', 'Term Months', 'Billing', 'TFC'],
      ['D-001', 'Maya Chen', 'Sam Okafor', 'Bea Lead', 'Jordan Reyes', 'Acme', '120000', '2026-01-20', '2026-02-01', '36', 'Upfront', 'N'],
      ['D-002', 'Maya Chen', '', '', 'Jordan Reyes', 'Globex', '45000', '2026-02-14', '2026-03-01', '12', 'Monthly', 'N'],
    ],
  },
  payments: {
    filename: 'payments-import-template.csv',
    rows: [
      ['Payment ID', 'Deal ID', 'Payment Date', 'Amount', 'Status'],
      ['P-001', 'D-001', '2026-02-05', '40000', 'Paid'],
      ['P-002', 'D-001', '2026-03-05', '40000', 'Paid'],
      ['P-003', 'D-002', '2026-03-10', '3750', 'Invoiced'],
    ],
  },
};
const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export async function setupRoutes(app: FastifyInstance, db: Db) {
  const requireAdmin = (req: FastifyRequest, reply: FastifyReply) => {
    if (req.user?.role !== 'admin') {
      reply.code(403).send({ error: 'Admin only' });
      return false;
    }
    return true;
  };

  // -- Restrict feature permissions -----------------------------------------
  // Runs after the session hook: req.user is set, or the request was already refused.
  const label = Object.fromEntries(PERMISSIONS.map((p) => [p.key, p.label]));
  app.addHook('onRequest', async (req, reply) => {
    if (!req.user || req.user.role === 'admin') return;
    const key = permissionFor(req.method, req.url);
    if (key && getAppSettings().permissions[key] === 'admin') {
      return reply.code(403).send({ error: `"${label[key]}" is restricted to admins (Setup › System Features › Restrict feature permissions).` });
    }
  });

  // -- Settings --------------------------------------------------------------
  app.get('/api/settings', async () => getAppSettings());

  app.put('/api/settings', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const before = getAppSettings();
    const next = await saveAppSettings(db, req.body);
    const changed = (Object.keys(next) as (keyof typeof next)[]).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(next[k]));
    await db.insert(auditLog).values({ actor: req.user!.email, action: 'settings.update', entityType: 'settings', detail: { sections: changed } });
    return next;
  });

  // -- Licensing: workspace usage -------------------------------------------
  app.get('/api/setup/usage', async () => {
    const n = sql<number>`count(*)::int`;
    const [byEmployeeStatus, [userCount], [importAgg], [planCount], [typeCount], [incentiveCount], [runCount], byLineStatus, byAssetOrigin, [periodAgg]] = await Promise.all([
      db.select({ status: employees.status, n }).from(employees).groupBy(employees.status),
      db.select({ n }).from(users),
      db.select({ n, rows: sql<number>`coalesce(sum(${imports.rowCount}), 0)::int` }).from(imports),
      db.select({ n }).from(compPlans),
      db.select({ n }).from(employeeTypes),
      db.select({ n }).from(criteriaSets),
      db.select({ n }).from(commissionRuns),
      db.select({ status: commissionLines.status, n }).from(commissionLines).groupBy(commissionLines.status),
      db.select({ origin: amortizationAssets.origin, n }).from(amortizationAssets).groupBy(amortizationAssets.origin),
      db.select({ n, latest: sql<string | null>`max(${accountingPeriods.month})` }).from(accountingPeriods),
    ]);
    const count = <R extends { n: number }>(rows: R[], pick: (r: R) => string, value: string) => rows.find((r) => pick(r) === value)?.n ?? 0;
    const total = (rows: { n: number }[]) => rows.reduce((s, r) => s + r.n, 0);
    const employeesByStatus = {
      active: count(byEmployeeStatus, (r) => r.status, 'active'),
      leave: total(byEmployeeStatus.filter((r) => /leave/.test(r.status))),
      terminated: count(byEmployeeStatus, (r) => r.status, 'terminated'),
      inactive: count(byEmployeeStatus, (r) => r.status, 'inactive'),
      total: total(byEmployeeStatus),
    };
    return {
      license: {
        edition: 'Self-hosted',
        status: 'Active',
        /** null = no limit. */
        tierMax: null as number | null,
        /** Active employees are what a seat tier would count. */
        countsTowardTier: employeesByStatus.active,
        syncedAt: new Date().toISOString(),
      },
      usage: {
        employees: employeesByStatus,
        users: userCount.n,
        imports: { count: importAgg.n, rows: importAgg.rows },
        compPlans: planCount.n,
        employeeTypes: typeCount.n,
        incentives: incentiveCount.n,
        runs: runCount.n,
        lines: {
          pay: count(byLineStatus, (r) => r.status, 'pay'),
          hold: count(byLineStatus, (r) => r.status, 'hold'),
          released: count(byLineStatus, (r) => r.status, 'released'),
          total: total(byLineStatus),
        },
        amortizations: {
          commission: count(byAssetOrigin, (r) => r.origin, 'commission'),
          manual: count(byAssetOrigin, (r) => r.origin, 'manual'),
          total: total(byAssetOrigin),
        },
        closedMonths: { count: periodAgg.n, latest: periodAgg.latest ?? null },
      },
    };
  });

  // -- Manage upgrades: what is running ---------------------------------------
  app.get('/api/setup/system', async () => {
    let lastUpgradedAt: string | null = null;
    try {
      // Written by the migrator on the first start that applied the latest migration.
      const r = (await db.execute(sql`select max(created_at) as t from drizzle.__drizzle_migrations`)) as unknown as { rows?: { t: unknown }[] } | { t: unknown }[];
      const rows = Array.isArray(r) ? r : (r.rows ?? []);
      const t = rows[0]?.t;
      if (t !== null && t !== undefined) lastUpgradedAt = new Date(Number(t)).toISOString();
    } catch {
      /* table missing or driver difference: leave null */
    }
    return {
      version: readVersion(),
      schema: readJournal(),
      lastUpgradedAt,
      startedAt,
      database: process.env.DATABASE_URL ? 'postgres' : 'pglite',
      node: process.version,
    };
  });

  // -- Import tools: templates ---------------------------------------------------
  app.get('/api/setup/templates/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    const t = TEMPLATES[name];
    if (!t) return reply.code(404).send({ error: 'No such template' });
    const csv = t.rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
    return reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="${t.filename}"`).send(csv);
  });
}
