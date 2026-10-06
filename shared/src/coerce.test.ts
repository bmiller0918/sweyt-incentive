import { describe, expect, it } from 'vitest';
import { formatDateMs, inferColumnType, parseBoolean, parseDate, parseNumber } from './coerce.js';

describe('parseNumber', () => {
  it('handles currency, commas, and parentheses', () => {
    expect(parseNumber('$1,234.50')).toBe(1234.5);
    expect(parseNumber('(500)')).toBe(-500);
    expect(parseNumber('($1,000.25)')).toBe(-1000.25);
    expect(parseNumber('-$3')).toBe(-3);
    expect(parseNumber('$-3')).toBe(-3);
    expect(parseNumber('500-')).toBe(-500);
    expect(parseNumber('12.5%')).toBe(12.5);
    expect(parseNumber('1e3')).toBe(1000);
  });
  it('rejects junk and blanks', () => {
    expect(parseNumber('')).toBeNull();
    expect(parseNumber('   ')).toBeNull();
    expect(parseNumber('abc')).toBeNull();
    expect(parseNumber('1,2,3x')).toBeNull();
  });
});

describe('parseDate', () => {
  it('parses ISO dates as UTC midnight', () => {
    expect(parseDate('2025-12-31')).toBe(Date.UTC(2025, 11, 31));
    expect(parseDate('2025-12-31T10:30:00Z')).toBe(Date.UTC(2025, 11, 31, 10, 30));
  });
  it('parses US slashes with 2- and 4-digit years', () => {
    expect(parseDate('12/31/2025')).toBe(Date.UTC(2025, 11, 31));
    expect(parseDate('12/31/25')).toBe(Date.UTC(2025, 11, 31));
    expect(parseDate('1/2/99')).toBe(Date.UTC(1999, 0, 2));
    expect(parseDate('1/2/2025 3:15 PM')).toBe(Date.UTC(2025, 0, 2, 15, 15));
  });
  it('parses Excel serials', () => {
    expect(parseDate('45658')).toBe(Date.UTC(2025, 0, 1)); // 2025-01-01
  });
  it('parses month names', () => {
    expect(parseDate('Dec 31, 2025')).toBe(Date.UTC(2025, 11, 31));
  });
  it('rejects invalid', () => {
    expect(parseDate('13/45/2025')).toBeNull();
    expect(parseDate('2025-02-30')).toBeNull();
    expect(parseDate('hello')).toBeNull();
  });
  it('formats back', () => {
    expect(formatDateMs(Date.UTC(2025, 11, 31), 'date')).toBe('2025-12-31');
  });
});

describe('parseBoolean', () => {
  it('maps common words', () => {
    expect(parseBoolean('Y')).toBe(true);
    expect(parseBoolean('no')).toBe(false);
    expect(parseBoolean('TRUE')).toBe(true);
    expect(parseBoolean('maybe')).toBeNull();
  });
});

describe('inferColumnType', () => {
  it('infers numbers with a few junk cells', () => {
    const vals = Array.from({ length: 100 }, (_, i) => String(i));
    vals.push('n/a');
    expect(inferColumnType(vals)).toBe('integer');
  });
  it('infers currency, percent, decimal', () => {
    expect(inferColumnType(['$10.00', '$20.50', '($5.00)'])).toBe('currency');
    expect(inferColumnType(['10%', '20.5%'])).toBe('percent');
    expect(inferColumnType(['1.5', '2.25', '3'])).toBe('decimal');
  });
  it('infers dates and booleans', () => {
    expect(inferColumnType(['1/1/2025', '2/15/2025', '12/31/25'])).toBe('date');
    expect(inferColumnType(['2025-01-01T10:00:00Z', '2025-01-02T11:00:00Z'])).toBe('datetime');
    expect(inferColumnType(['Y', 'N', 'Y', ''])).toBe('boolean');
  });
  it('falls back to text', () => {
    expect(inferColumnType(['Alice', 'Bob', '42'])).toBe('text');
    expect(inferColumnType([])).toBe('text');
  });
});
