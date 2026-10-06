import type { ColumnType, RawRow, TypedRow, TypedValue } from './types.js';

const TRUE_WORDS = new Set(['true', 'yes', 'y', 't', '1', 'x', 'on']);
const FALSE_WORDS = new Set(['false', 'no', 'n', 'f', '0', 'off']);

export function isBlank(raw: string | null | undefined): boolean {
  return raw == null || raw.trim() === '';
}

/**
 * Parse messy numeric text: "$1,234.50", "(500)" => -500, "12.5%", "500-".
 * Thousands separators and currency symbols are stripped.
 */
export function parseNumber(raw: string): number | null {
  if (isBlank(raw)) return null;
  let s = raw.trim();
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.endsWith('-')) {
    negative = true;
    s = s.slice(0, -1);
  }
  s = s.replace(/[$€£¥,\s]/g, '').replace(/%$/, '');
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }
  if (!/^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/** Days between 1899-12-30 (Excel epoch) and 1970-01-01. */
const EXCEL_EPOCH_OFFSET_DAYS = 25569;
const MS_PER_DAY = 86_400_000;

/** Excel stores dates as day serials; a plausible range is 1900..2200. */
function excelSerialToMs(n: number): number | null {
  if (n < 1 || n > 110_000) return null;
  return Math.round((n - EXCEL_EPOCH_OFFSET_DAYS) * MS_PER_DAY);
}

function utcMs(y: number, m: number, d: number, hh = 0, mm = 0, ss = 0): number | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const ms = Date.UTC(y, m - 1, d, hh, mm, ss);
  const check = new Date(ms);
  if (check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  return ms;
}

/**
 * Parse a date or datetime into epoch milliseconds, treated as UTC so that
 * date-only values compare consistently regardless of server timezone.
 *
 * Accepts ISO (2025-12-31, 2025-12-31T10:00:00Z), US slashes (12/31/2025,
 * 12/31/25), dashes (12-31-2025), "Dec 31, 2025", "31 Dec 2025", and Excel
 * serial numbers.
 */
export function parseDate(raw: string): number | null {
  if (isBlank(raw)) return null;
  const s = raw.trim();

  // ISO date / datetime
  let m = s.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/,
  );
  if (m) {
    const [, y, mo, d, hh, mi, ss, tz] = m;
    if (tz && tz !== 'Z') {
      const t = Date.parse(s);
      return Number.isNaN(t) ? null : t;
    }
    return utcMs(+y, +mo, +d, hh ? +hh : 0, mi ? +mi : 0, ss ? +ss : 0);
  }

  // US m/d/y or m-d-y, with optional time
  m = s.match(
    /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2}|\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM|am|pm)?)?$/,
  );
  if (m) {
    const [, mo, d, yRaw, hhRaw, mi, ss, ampm] = m;
    let y = +yRaw;
    if (yRaw.length === 2) y += y < 70 ? 2000 : 1900;
    let hh = hhRaw ? +hhRaw : 0;
    if (ampm) {
      const pm = ampm.toLowerCase() === 'pm';
      if (pm && hh < 12) hh += 12;
      if (!pm && hh === 12) hh = 0;
    }
    return utcMs(y, +mo, +d, hh, mi ? +mi : 0, ss ? +ss : 0);
  }

  // Excel serial
  if (/^\d+(\.\d+)?$/.test(s)) {
    return excelSerialToMs(Number(s));
  }

  // Month names: "Dec 31, 2025", "31 Dec 2025", "December 31 2025"
  if (/[A-Za-z]{3}/.test(s)) {
    const t = Date.parse(/\d{1,2}:\d{2}/.test(s) ? s : s + ' UTC');
    if (!Number.isNaN(t)) return t;
  }

  return null;
}

export function parseBoolean(raw: string): boolean | null {
  if (isBlank(raw)) return null;
  const s = raw.trim().toLowerCase();
  if (TRUE_WORDS.has(s)) return true;
  if (FALSE_WORDS.has(s)) return false;
  return null;
}

export function coerceValue(raw: string | null | undefined, type: ColumnType): TypedValue {
  if (raw == null) return null;
  switch (type) {
    case 'text':
      return raw;
    case 'integer':
    case 'decimal':
    case 'currency':
    case 'percent':
      return parseNumber(raw);
    case 'date':
    case 'datetime':
      return parseDate(raw);
    case 'boolean':
      return parseBoolean(raw);
  }
}

export function coerceRow(raw: RawRow, types: Record<string, ColumnType>): TypedRow {
  const out: TypedRow = {};
  for (const key in types) {
    out[key] = coerceValue(raw[key], types[key]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Type inference
// ---------------------------------------------------------------------------

const INFER_SAMPLE = 2000;
const INFER_THRESHOLD = 0.95;

/**
 * Guess a column type from its raw values. Looks at up to 2000 non-blank
 * values and requires 95% agreement, so a handful of junk cells won't force
 * a numeric column to text.
 */
export function inferColumnType(values: Iterable<string>): ColumnType {
  let seen = 0;
  let bool = 0;
  let int = 0;
  let num = 0;
  let currency = 0;
  let percent = 0;
  let date = 0;
  let datetime = 0;

  for (const v of values) {
    if (isBlank(v)) continue;
    if (seen >= INFER_SAMPLE) break;
    seen++;
    const s = v.trim();

    if (parseBoolean(s) !== null && !/^\d+$/.test(s)) bool++;

    const n = parseNumber(s);
    if (n !== null) {
      num++;
      if (/[$€£¥]/.test(s)) currency++;
      if (/%$/.test(s)) percent++;
      if (Number.isInteger(n) && !/[.]/.test(s)) int++;
    }

    // Only count as a date if it's not a plain number (Excel serials are
    // too ambiguous to infer; the user can override to date).
    if (n === null && parseDate(s) !== null) {
      date++;
      if (/\d{1,2}:\d{2}/.test(s)) datetime++;
    }
  }

  if (seen === 0) return 'text';
  const ratio = (x: number) => x / seen;

  if (ratio(bool) >= INFER_THRESHOLD) return 'boolean';
  if (ratio(date) >= INFER_THRESHOLD) return ratio(datetime) >= 0.5 ? 'datetime' : 'date';
  if (ratio(num) >= INFER_THRESHOLD) {
    if (ratio(percent) >= 0.5) return 'percent';
    if (ratio(currency) >= 0.5) return 'currency';
    if (ratio(int) >= INFER_THRESHOLD) return 'integer';
    return 'decimal';
  }
  return 'text';
}

/** Format epoch-ms back to an ISO date or datetime string for display/export. */
export function formatDateMs(ms: number, type: 'date' | 'datetime'): string {
  const iso = new Date(ms).toISOString();
  return type === 'date' ? iso.slice(0, 10) : iso.replace('.000Z', 'Z');
}
