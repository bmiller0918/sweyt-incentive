import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { loadAppSettings } from './appSettings.js';
import { setupAuth } from './auth.js';
import { config } from './config.js';
import { createDb } from './db/client.js';
import { accountingRoutes } from './routes/accounting.js';
import { commissionRoutes } from './routes/commissions.js';
import { criteriaRoutes } from './routes/criteria.js';
import { importRoutes } from './routes/imports.js';
import { payoutRuleRoutes } from './routes/payoutRules.js';
import { planRoutes } from './routes/plans.js';
import { payrollTemplateRoutes } from './routes/payrollTemplates.js';
import { programRoutes } from './routes/programs.js';
import { setupRoutes } from './routes/setup.js';

const here = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const app = Fastify({ logger: { level: config.isProduction ? 'info' : 'warn' }, bodyLimit: 20 * 1024 * 1024 });
  // Same-origin app: the browser sends the session cookie; no cross-site origins are allowed credentials.
  await app.register(cors, { origin: false });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 1 } });

  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'Invalid request', issues: err.issues });
    }
    app.log.error(err);
    const e = err as { statusCode?: number; message?: string };
    reply.code(e.statusCode ?? 500).send({ error: e.message ?? 'Internal error' });
  });

  app.get('/health', async () => ({ ok: true, uptime: process.uptime() }));

  const db = await createDb();
  // Must come before the data routes: it adds the session hook that guards /api/*.
  await setupAuth(app, db);
  // Settings must be in memory before any route reads the calendar; the permission hook goes right after auth.
  await loadAppSettings(db);
  await setupRoutes(app, db);
  await importRoutes(app, db);
  await criteriaRoutes(app, db);
  await planRoutes(app, db);
  await programRoutes(app, db);
  await payrollTemplateRoutes(app, db);
  await commissionRoutes(app, db);
  await payoutRuleRoutes(app, db);
  await accountingRoutes(app, db);

  // In production the server also serves the built web app.
  const webDist = [path.resolve(here, '../../web/dist'), path.resolve(here, '../web/dist')].find((p) => fs.existsSync(p));
  if (webDist) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' });
      return reply.sendFile('index.html');
    });
  }

  await app.listen({ port: config.port, host: config.host });
  console.log(`[server] listening on http://${config.host}:${config.port}${webDist ? ' (serving web)' : ''}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
