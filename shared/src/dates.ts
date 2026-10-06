// Relative date presets ("this quarter", "last 30 days", ...) resolved to an
// inclusive [start, end] range in epoch-ms at UTC day boundaries.

export const RELATIVE_PRESETS = [
  'today',
  'yesterday',
  'this_week',
  'last_week',
  'this_month',
  'last_month',
  'this_quarter',
  'last_quarter',
  'this_year',
  'last_year',
  'this_fiscal_quarter',
  'last_fiscal_quarter',
  'this_fiscal_year',
  'last_fiscal_year',
  'last_n_days',
  'next_n_days',
  'year_to_date',
  'quarter_to_date',
  'month_to_date',
] as const;

export type RelativePreset = (typeof RELATIVE_PRESETS)[number];

export const RELATIVE_LABELS: Record<RelativePreset, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  this_week: 'This week',
  last_week: 'Last week',
  this_month: 'This month',
  last_month: 'Last month',
  this_quarter: 'This quarter',
  last_quarter: 'Last quarter',
  this_year: 'This year',
  last_year: 'Last year',
  this_fiscal_quarter: 'This fiscal quarter',
  last_fiscal_quarter: 'Last fiscal quarter',
  this_fiscal_year: 'This fiscal year',
  last_fiscal_year: 'Last fiscal year',
  last_n_days: 'Last N days',
  next_n_days: 'Next N days',
  year_to_date: 'Year to date',
  quarter_to_date: 'Quarter to date',
  month_to_date: 'Month to date',
};

export const PRESETS_NEEDING_N: ReadonlySet<RelativePreset> = new Set(['last_n_days', 'next_n_days']);

export interface DateContext {
  /** "Now" in epoch-ms; defaults to Date.now(). Injectable for tests. */
  now?: number;
  /** 1-12. Month in which the fiscal year starts (1 = calendar year). */
  fiscalYearStartMonth?: number;
  /** 0 = Sunday, 1 = Monday. */
  weekStartsOn?: 0 | 1;
}

const MS_PER_DAY = 86_400_000;

export function startOfDayUtc(ms: number): number {
  return Math.floor(ms / MS_PER_DAY) * MS_PER_DAY;
}

export function endOfDayUtc(ms: number): number {
  return startOfDayUtc(ms) + MS_PER_DAY - 1;
}

function ymd(ms: number) {
  const d = new Date(ms);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), dow: d.getUTCDay() };
}

function range(startMs: number, endMsExclusive: number): [number, number] {
  return [startMs, endMsExclusive - 1];
}

function monthRange(y: number, m: number, count = 1): [number, number] {
  return range(Date.UTC(y, m, 1), Date.UTC(y, m + count, 1));
}

/** Resolve a preset to an inclusive [start, end] range. */
export function resolveRelativeRange(
  preset: RelativePreset,
  n: number | undefined,
  ctx: DateContext = {},
): [number, number] {
  const now = ctx.now ?? Date.now();
  const fyStart = Math.min(12, Math.max(1, ctx.fiscalYearStartMonth ?? 1)) - 1; // 0-based
  const weekStart = ctx.weekStartsOn ?? 1;
  const today = startOfDayUtc(now);
  const { y, m, dow } = ymd(now);

  switch (preset) {
    case 'today':
      return range(today, today + MS_PER_DAY);
    case 'yesterday':
      return range(today - MS_PER_DAY, today);
    case 'this_week': {
      const offset = (dow - weekStart + 7) % 7;
      const start = today - offset * MS_PER_DAY;
      return range(start, start + 7 * MS_PER_DAY);
    }
    case 'last_week': {
      const offset = (dow - weekStart + 7) % 7;
      const start = today - offset * MS_PER_DAY - 7 * MS_PER_DAY;
      return range(start, start + 7 * MS_PER_DAY);
    }
    case 'this_month':
      return monthRange(y, m);
    case 'last_month':
      return monthRange(y, m - 1);
    case 'month_to_date':
      return range(Date.UTC(y, m, 1), today + MS_PER_DAY);
    case 'this_quarter': {
      const qm = Math.floor(m / 3) * 3;
      return monthRange(y, qm, 3);
    }
    case 'last_quarter': {
      const qm = Math.floor(m / 3) * 3 - 3;
      return monthRange(y, qm, 3);
    }
    case 'quarter_to_date': {
      const qm = Math.floor(m / 3) * 3;
      return range(Date.UTC(y, qm, 1), today + MS_PER_DAY);
    }
    case 'this_year':
      return monthRange(y, 0, 12);
    case 'last_year':
      return monthRange(y - 1, 0, 12);
    case 'year_to_date':
      return range(Date.UTC(y, 0, 1), today + MS_PER_DAY);
    case 'this_fiscal_year':
    case 'last_fiscal_year': {
      // The fiscal year is named by the calendar year it starts in.
      const fyStartYear = y - (m < fyStart ? 1 : 0);
      const shift = preset === 'last_fiscal_year' ? -1 : 0;
      return monthRange(fyStartYear + shift, fyStart, 12);
    }
    case 'this_fiscal_quarter':
    case 'last_fiscal_quarter': {
      const sinceStart = (m - fyStart + 12) % 12;
      const qIndex = Math.floor(sinceStart / 3);
      const fyStartYear = y - (m < fyStart ? 1 : 0);
      const shift = preset === 'last_fiscal_quarter' ? -1 : 0;
      return monthRange(fyStartYear, fyStart + (qIndex + shift) * 3, 3);
    }
    case 'last_n_days': {
      const days = Math.max(1, Math.floor(n ?? 7));
      // Includes today: "last 7 days" = today and the 6 before it.
      return range(today - (days - 1) * MS_PER_DAY, today + MS_PER_DAY);
    }
    case 'next_n_days': {
      const days = Math.max(1, Math.floor(n ?? 7));
      return range(today, today + days * MS_PER_DAY);
    }
  }
  // Exhaustive switch; TypeScript errors here if a preset is unhandled.
  const _never: never = preset;
  return _never;
}
