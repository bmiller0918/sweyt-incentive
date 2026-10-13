// The global settings document (Setup page), cached in memory so routes can
// read it synchronously. Loaded once at startup; the cache is replaced on save.
import { DEFAULT_APP_SETTINGS, appSettingsSchema, formatRecordNumber, normalizeSettings, type AppSettings } from '@commissions/shared';
import { eq } from 'drizzle-orm';
import { config } from './config.js';
import type { Db } from './db/client.js';
import { appSettings } from './db/schema.js';

/** Before the database is read: the defaults, with the fiscal calendar from the environment. */
const fromEnvironment = (): AppSettings =>
  normalizeSettings({ ...DEFAULT_APP_SETTINGS, general: { ...DEFAULT_APP_SETTINGS.general, fiscalYearStartMonth: config.fiscalYearStartMonth, weekStartsOn: config.weekStartsOn } });

let current: AppSettings = fromEnvironment();
let rowId: string | null = null;

export function getAppSettings(): AppSettings {
  return current;
}

/** The fiscal calendar every relative-date evaluation uses. */
export const calendar = () => ({ fiscalYearStartMonth: current.general.fiscalYearStartMonth, weekStartsOn: current.general.weekStartsOn });

/** AMRT0001-style id of an amortization record, with the configured prefix and width. */
export const recordNumber = (n: number) => formatRecordNumber(n, current.general.amortizationPrefix, current.general.amortizationMinDigits);

/** Read the stored document, or create it from the environment on first run. */
export async function loadAppSettings(db: Db): Promise<AppSettings> {
  const [row] = await db.select().from(appSettings).limit(1);
  if (row) {
    rowId = row.id;
    try {
      current = normalizeSettings(row.settings);
    } catch (e) {
      console.warn(`[settings] stored settings are invalid, using defaults: ${(e as Error).message}`);
      current = fromEnvironment();
    }
    return current;
  }
  const [created] = await db.insert(appSettings).values({ settings: fromEnvironment() }).returning();
  rowId = created.id;
  current = normalizeSettings(created.settings);
  return current;
}

/** Validate, store and switch the cache to a new document. */
export async function saveAppSettings(db: Db, next: unknown): Promise<AppSettings> {
  const parsed = appSettingsSchema.parse(next);
  if (!rowId) await loadAppSettings(db);
  await db.update(appSettings).set({ settings: parsed, updatedAt: new Date() }).where(eq(appSettings.id, rowId!));
  current = parsed;
  return current;
}

/** Tests only: set the cache without a database. */
export function setAppSettingsForTest(next: AppSettings) {
  current = next;
}
