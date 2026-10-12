// Email + password accounts with cookie sessions.
//
//   - Passwords: scrypt (Node built-in), random 16-byte salt, constant-time compare.
//   - Sessions: random 32-byte token in an httpOnly cookie; only its SHA-256
//     hash is stored, so a database leak does not leak live sessions.
//   - First run: no users -> /api/auth/status reports setupRequired and
//     /api/auth/setup creates the first admin. After that, setup is closed.
//   - Every /api/* route except /health and /api/auth/* requires a session,
//     and an account still on its temporary password can only use /api/auth/*.
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { and, eq, gt, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from './config.js';
import type { Db } from './db/client.js';
import { auditLog, sessions, users } from './db/schema.js';

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

export const SESSION_COOKIE = 'sid';
const SESSION_DAYS = 30;
const MIN_PASSWORD = 10;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, saltB64, keyB64] = stored.split('$');
  if (algo !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: string;
  mustChangePassword: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

/** Simple in-memory brute-force guard: 10 failures per key per 15 minutes. */
const failures = new Map<string, { n: number; until: number }>();
function tooManyFailures(key: string): boolean {
  const f = failures.get(key);
  return !!f && f.n >= 10 && f.until > Date.now();
}
function recordFailure(key: string) {
  const f = failures.get(key);
  const until = Date.now() + 15 * 60 * 1000;
  if (!f || f.until < Date.now()) failures.set(key, { n: 1, until });
  else failures.set(key, { n: f.n + 1, until });
}

export async function setupAuth(app: FastifyInstance, db: Db) {
  const publicUser = (u: typeof users.$inferSelect): SessionUser => ({
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    mustChangePassword: !!u.mustChangePassword,
  });

  const userCount = async () => (await db.select({ n: sql<number>`count(*)::int` }).from(users))[0].n;

  const issueSession = async (reply: FastifyReply, userId: string, userAgent?: string) => {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
    await db.insert(sessions).values({ tokenHash: hashToken(token), userId, expiresAt, userAgent: userAgent?.slice(0, 200) ?? null });
    reply.setCookie(SESSION_COOKIE, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: config.isProduction,
      maxAge: SESSION_DAYS * 86_400,
    });
  };

  const clearSession = async (req: FastifyRequest, reply: FastifyReply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
  };

  // -- Resolve the session on every request ----------------------------------
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req, reply) => {
    req.user = null;
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) {
      const [row] = await db
        .select({ u: users })
        .from(sessions)
        .innerJoin(users, eq(sessions.userId, users.id))
        .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())));
      if (row) req.user = publicUser(row.u);
    }
    const url = req.url.split('?')[0];
    const isApi = url.startsWith('/api/');
    const open = url === '/health' || url.startsWith('/api/auth/');
    if (isApi && !open && !req.user) return reply.code(401).send({ error: 'Sign in required' });
    // A temporary password only opens /api/auth/* (change-password, me, logout) until it is replaced.
    if (isApi && !open && req.user?.mustChangePassword) return reply.code(403).send({ error: 'Password change required' });
  });

  // -- Routes ------------------------------------------------------------------
  app.get('/api/auth/status', async (req) => ({ setupRequired: (await userCount()) === 0, user: req.user }));

  const credentials = z.object({ email: z.string().email(), password: z.string().min(1) });
  const setupSchema = z.object({ email: z.string().email(), name: z.string().min(1), password: z.string().min(MIN_PASSWORD) });

  /** Create the first admin. Only works while there are no users at all. */
  app.post('/api/auth/setup', async (req, reply) => {
    if ((await userCount()) > 0) return reply.code(403).send({ error: 'Setup is already complete' });
    const body = setupSchema.parse(req.body);
    const [u] = await db
      .insert(users)
      .values({ email: body.email.trim().toLowerCase(), name: body.name.trim(), passwordHash: await hashPassword(body.password), role: 'admin' })
      .returning();
    await db.insert(auditLog).values({ actor: u.email, action: 'auth.setup', entityType: 'user', entityId: u.id });
    await issueSession(reply, u.id, req.headers['user-agent']);
    return { user: publicUser(u) };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const body = credentials.parse(req.body);
    const email = body.email.trim().toLowerCase();
    const key = `${req.ip}|${email}`;
    if (tooManyFailures(key)) return reply.code(429).send({ error: 'Too many attempts; try again in 15 minutes' });
    const [u] = await db.select().from(users).where(eq(users.email, email));
    const ok = u ? await verifyPassword(body.password, u.passwordHash) : false;
    if (!u || !ok) {
      recordFailure(key);
      return reply.code(401).send({ error: 'Incorrect email or password' });
    }
    failures.delete(key);
    await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, u.id));
    await db.insert(auditLog).values({ actor: u.email, action: 'auth.login', entityType: 'user', entityId: u.id });
    await issueSession(reply, u.id, req.headers['user-agent']);
    return { user: publicUser(u) };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    await clearSession(req, reply);
    return reply.code(204).send();
  });

  app.get('/api/auth/me', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'Sign in required' });
    return { user: req.user };
  });

  const changeSchema = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(MIN_PASSWORD) });
  app.post('/api/auth/change-password', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'Sign in required' });
    const body = changeSchema.parse(req.body);
    const [u] = await db.select().from(users).where(eq(users.id, req.user.id));
    if (!u || !(await verifyPassword(body.currentPassword, u.passwordHash))) return reply.code(400).send({ error: 'Current password is incorrect' });
    await db.update(users).set({ passwordHash: await hashPassword(body.newPassword), mustChangePassword: 0, updatedAt: new Date() }).where(eq(users.id, u.id));
    // Other sessions are signed out; this one is re-issued.
    await db.delete(sessions).where(eq(sessions.userId, u.id));
    await issueSession(reply, u.id, req.headers['user-agent']);
    await db.insert(auditLog).values({ actor: u.email, action: 'auth.change_password', entityType: 'user', entityId: u.id });
    return { ok: true };
  });

  // -- User management (admins) -----------------------------------------------
  const requireAdmin = (req: FastifyRequest, reply: FastifyReply) => {
    if (req.user?.role !== 'admin') {
      reply.code(403).send({ error: 'Admin only' });
      return false;
    }
    return true;
  };

  app.get('/api/users', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const rows = await db.select().from(users).orderBy(users.email);
    return rows.map((u) => ({ ...publicUser(u), lastLoginAt: u.lastLoginAt, createdAt: u.createdAt }));
  });

  const createUserSchema = z.object({ email: z.string().email(), name: z.string().min(1), role: z.enum(['admin', 'member']).default('member') });
  /** Create an account with a temporary password that is returned once. */
  app.post('/api/users', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const body = createUserSchema.parse(req.body);
    const email = body.email.trim().toLowerCase();
    const [dupe] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (dupe) return reply.code(409).send({ error: 'A user with that email already exists' });
    const tempPassword = randomBytes(9).toString('base64url');
    const [u] = await db
      .insert(users)
      .values({ email, name: body.name.trim(), role: body.role, passwordHash: await hashPassword(tempPassword), mustChangePassword: 1 })
      .returning();
    await db.insert(auditLog).values({ actor: req.user!.email, action: 'user.create', entityType: 'user', entityId: u.id, detail: { role: body.role } });
    return { user: publicUser(u), tempPassword };
  });

  app.delete('/api/users/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    if (id === req.user!.id) return reply.code(400).send({ error: 'You cannot delete your own account' });
    await db.delete(users).where(eq(users.id, id));
    await db.insert(auditLog).values({ actor: req.user!.email, action: 'user.delete', entityType: 'user', entityId: id });
    return reply.code(204).send();
  });
}
