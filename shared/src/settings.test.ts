import { describe, expect, it } from 'vitest';
import { DEFAULT_APP_SETTINGS, FEATURE_KEYS, PERMISSION_KEYS, QUICK_ACTION_KEYS, formatRecordNumber, monthOf, normalizeSettings } from './settings.js';

describe('normalizeSettings', () => {
  it('fills every default from an empty document', () => {
    const s = normalizeSettings({});
    expect(s).toEqual(DEFAULT_APP_SETTINGS);
    expect(s.general.goLiveDate).toBeNull();
    expect(s.general.fiscalYearStartMonth).toBe(1);
    expect(s.general.amortizationPrefix).toBe('AMRT');
    for (const k of FEATURE_KEYS) expect(s.features[k]).toBe(true);
    for (const k of QUICK_ACTION_KEYS) expect(s.quickActions[k]).toBe(true);
    for (const k of PERMISSION_KEYS) expect(s.permissions[k]).toBe('all');
    expect(s.upgrades.preference).toBe('automatic');
  });

  it('keeps stored values and adds keys a stored document is missing', () => {
    const s = normalizeSettings({ general: { goLiveDate: '2025-01-01', fiscalYearStartMonth: 2 }, features: { accounting: false }, permissions: { close: 'admin' } });
    expect(s.general.goLiveDate).toBe('2025-01-01');
    expect(s.general.fiscalYearStartMonth).toBe(2);
    expect(s.general.defaultPayLagMonths).toBe(1);
    expect(s.features.accounting).toBe(false);
    expect(s.features.holds).toBe(true);
    expect(s.permissions.close).toBe('admin');
    expect(s.permissions.runs).toBe('all');
  });

  it('drops keys it does not know', () => {
    const s = normalizeSettings({ general: { bogus: 1 }, features: { oldFeature: true } }) as unknown as Record<string, Record<string, unknown>>;
    expect('bogus' in s.general).toBe(false);
    expect('oldFeature' in s.features).toBe(false);
  });

  it('rejects bad values', () => {
    expect(() => normalizeSettings({ general: { goLiveDate: '1/1/2025' } })).toThrow();
    expect(() => normalizeSettings({ general: { fiscalYearStartMonth: 13 } })).toThrow();
    expect(() => normalizeSettings({ general: { amortizationPrefix: 'A B' } })).toThrow();
    expect(() => normalizeSettings({ permissions: { runs: 'nobody' } })).toThrow();
    expect(() => normalizeSettings({ upgrades: { releaseNotesRecipients: [{ name: 'A', email: 'not-an-email' }] } })).toThrow();
  });

  it('does not share nested objects with DEFAULT_APP_SETTINGS', () => {
    const s = normalizeSettings({});
    s.features.accounting = false;
    expect(DEFAULT_APP_SETTINGS.features.accounting).toBe(true);
  });
});

describe('formatRecordNumber', () => {
  it('pads to the minimum digits and keeps longer numbers whole', () => {
    expect(formatRecordNumber(1, 'AMRT', 4)).toBe('AMRT0001');
    expect(formatRecordNumber(12345, 'AMRT', 4)).toBe('AMRT12345');
    expect(formatRecordNumber(7, 'DC-', 2)).toBe('DC-07');
  });
});

describe('monthOf', () => {
  it('takes the YYYY-MM of an ISO date', () => {
    expect(monthOf('2026-03-15')).toBe('2026-03');
    expect(monthOf(null)).toBeNull();
    expect(monthOf('')).toBeNull();
  });
});
