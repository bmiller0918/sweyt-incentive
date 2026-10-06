import type { ColumnDef, RawRow } from '@commissions/shared';
import * as XLSX from 'xlsx';

/**
 * Guard against CSV/formula injection: a cell beginning with = + - @ (or a
 * tab/CR) would be executed by Excel on open. Prefix it with an apostrophe.
 */
export function sanitizeCell(v: string): string {
  if (/^[=+\-@\t\r]/.test(v)) return `'${v}`;
  return v;
}

function csvEscape(v: string): string {
  const s = sanitizeCell(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns: ColumnDef[], rows: RawRow[]): string {
  const names = columns.map((c) => c.name);
  const lines = [names.map(csvEscape).join(',')];
  for (const r of rows) lines.push(names.map((n) => csvEscape(r[n] ?? '')).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

export function toXlsx(columns: ColumnDef[], rows: RawRow[]): Buffer {
  const names = columns.map((c) => c.name);
  const aoa = [names, ...rows.map((r) => names.map((n) => sanitizeCell(r[n] ?? '')))];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Export');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}
