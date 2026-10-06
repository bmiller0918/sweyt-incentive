// Turns an uploaded CSV/TSV/Excel buffer into a sheet list plus raw string
// cells. Headers/typing happen later once the user has picked a sheet and
// header row.
import Papa from 'papaparse';
import * as XLSX from 'xlsx';

export type Grid = string[][];

export interface ParsedFile {
  kind: 'csv' | 'excel';
  sheets: { name: string; rows: Grid }[];
}

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0]);

/** Sniff the container format from bytes rather than trusting the extension. */
export function detectKind(buf: Buffer): 'excel' | 'csv' | 'unknown' {
  if (buf.subarray(0, 4).equals(ZIP_MAGIC) || buf.subarray(0, 4).equals(OLE_MAGIC)) return 'excel';
  // Text: reject if the first chunk has NUL bytes (binary).
  const head = buf.subarray(0, 4096);
  for (const b of head) if (b === 0) return 'unknown';
  return 'csv';
}

function decodeText(buf: Buffer): string {
  // UTF-8 BOM
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  // UTF-16 LE BOM (Excel "Unicode Text" export)
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

export function parseCsv(buf: Buffer): ParsedFile {
  const text = decodeText(buf);
  const result = Papa.parse<string[]>(text, {
    delimitersToGuess: [',', '\t', '|', ';'],
    skipEmptyLines: 'greedy',
  });
  const rows = result.data.map((r) => r.map((c) => (c == null ? '' : String(c))));
  return { kind: 'csv', sheets: [{ name: 'Sheet1', rows }] };
}

function cellToString(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) {
    const iso = v.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
  }
  return String(v);
}

export function parseExcel(buf: Buffer): ParsedFile {
  // cellDates gives Date objects for date-formatted cells; formulas are
  // never evaluated, we only read cached values.
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true, cellFormula: false });
  const sheets = wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name];
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: '' });
    const rows: Grid = aoa.map((r) => r.map(cellToString));
    return { name, rows };
  });
  return { kind: 'excel', sheets };
}

export function parseBuffer(buf: Buffer): ParsedFile {
  const kind = detectKind(buf);
  if (kind === 'excel') return parseExcel(buf);
  if (kind === 'csv') return parseCsv(buf);
  throw new Error('Unsupported file: expected CSV, TSV, or Excel');
}

/**
 * Split a grid into headers + records using the chosen header row. Blank or
 * duplicate headers are made unique ("Column 3", "Amount (2)").
 */
export function applyHeaderRow(grid: Grid, headerRow: number): { headers: string[]; records: Record<string, string>[] } {
  const headerCells = grid[headerRow] ?? [];
  const width = Math.max(headerCells.length, ...grid.slice(headerRow + 1, headerRow + 50).map((r) => r.length));
  const seen = new Map<string, number>();
  const headers: string[] = [];
  for (let i = 0; i < width; i++) {
    let h = (headerCells[i] ?? '').trim();
    if (!h) h = `Column ${i + 1}`;
    const n = seen.get(h) ?? 0;
    seen.set(h, n + 1);
    headers.push(n === 0 ? h : `${h} (${n + 1})`);
  }
  const records: Record<string, string>[] = [];
  for (let r = headerRow + 1; r < grid.length; r++) {
    const row = grid[r];
    if (!row || row.every((c) => c.trim() === '')) continue;
    const rec: Record<string, string> = {};
    for (let i = 0; i < width; i++) rec[headers[i]] = row[i] ?? '';
    records.push(rec);
  }
  return { headers, records };
}
