import { describe, expect, it } from 'vitest';
import { sanitizeCell, toCsv } from './export.js';
import { applyHeaderRow, detectKind, parseCsv } from './parse.js';

describe('parseCsv', () => {
  it('auto-detects delimiter and handles quotes/newlines', () => {
    const csv = 'a\tb\n"x\ny"\t2\n';
    const p = parseCsv(Buffer.from(csv));
    expect(p.sheets[0].rows).toEqual([
      ['a', 'b'],
      ['x\ny', '2'],
    ]);
  });
  it('strips a UTF-8 BOM', () => {
    const p = parseCsv(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('h\n1\n')]));
    expect(p.sheets[0].rows[0]).toEqual(['h']);
  });
  it('falls back to windows-1252', () => {
    const p = parseCsv(Buffer.from([0x63, 0x61, 0x66, 0xe9])); // "café" in latin-1
    expect(p.sheets[0].rows[0][0]).toBe('café');
  });
});

describe('detectKind', () => {
  it('sniffs zip/ole as excel and text as csv', () => {
    expect(detectKind(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]))).toBe('excel');
    expect(detectKind(Buffer.from('a,b\n1,2'))).toBe('csv');
    expect(detectKind(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]))).toBe('unknown');
  });
});

describe('applyHeaderRow', () => {
  it('skips title rows, uniquifies headers, drops blank rows', () => {
    const grid = [
      ['Report Title'],
      [],
      ['Rep', '', 'Amount', 'Amount'],
      ['A', '1', '2', '3'],
      ['', '', '', ''],
      ['B', '4', '5'],
    ];
    const { headers, records } = applyHeaderRow(grid, 2);
    expect(headers).toEqual(['Rep', 'Column 2', 'Amount', 'Amount (2)']);
    expect(records).toEqual([
      { Rep: 'A', 'Column 2': '1', Amount: '2', 'Amount (2)': '3' },
      { Rep: 'B', 'Column 2': '4', Amount: '5', 'Amount (2)': '' },
    ]);
  });
});

describe('export', () => {
  it('neutralises formula injection and quotes', () => {
    expect(sanitizeCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(sanitizeCell('plain')).toBe('plain');
    const csv = toCsv(
      [{ name: 'a', index: 0, type: 'text', inferredType: 'text' }],
      [{ a: 'he said "hi"' }, { a: '+1' }],
    );
    expect(csv).toContain('"he said ""hi"""');
    expect(csv).toContain("'+1");
  });
});
