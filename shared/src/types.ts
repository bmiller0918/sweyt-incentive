// Column types the import tool understands. Raw cell values are always stored
// as strings; these types drive coercion, operator lists, and comparisons.
export const COLUMN_TYPES = [
  'text',
  'integer',
  'decimal',
  'currency',
  'percent',
  'date',
  'datetime',
  'boolean',
] as const;

export type ColumnType = (typeof COLUMN_TYPES)[number];

export type ColumnFamily = 'text' | 'number' | 'date' | 'boolean';

export function familyOf(type: ColumnType): ColumnFamily {
  switch (type) {
    case 'integer':
    case 'decimal':
    case 'currency':
    case 'percent':
      return 'number';
    case 'date':
    case 'datetime':
      return 'date';
    case 'boolean':
      return 'boolean';
    default:
      return 'text';
  }
}

export interface ColumnDef {
  /** Header text exactly as it appears in the file (unique within an import). */
  name: string;
  /** Zero-based position in the source file. */
  index: number;
  /** The type currently in effect (user override wins over inference). */
  type: ColumnType;
  /** What inference guessed, kept so the UI can show "overridden". */
  inferredType: ColumnType;
}

/** A row as stored: header name -> raw cell text. */
export type RawRow = Record<string, string>;

/** A coerced cell: text, number, epoch-ms, boolean, or null for blank/unparseable. */
export type TypedValue = string | number | boolean | null;

/** A row after coercion against its column types. */
export type TypedRow = Record<string, TypedValue>;
