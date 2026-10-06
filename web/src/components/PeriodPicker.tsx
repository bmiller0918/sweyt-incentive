import { RELATIVE_LABELS, formatDateMs, resolveRelativeRange, type RelativePreset } from '@commissions/shared';
import { useEffect, useState } from 'react';
import { api, type AppConfig } from '../api';

// Fiscal settings come from the server once; cached for every picker.
let configPromise: Promise<AppConfig> | null = null;
function loadConfig() {
  if (!configPromise) configPromise = api.getConfig().catch(() => ({ fiscalYearStartMonth: 1, weekStartsOn: 1 as const }));
  return configPromise;
}

/** Presets offered for "effective period", in display order. */
const PRESETS: RelativePreset[] = [
  'this_fiscal_year',
  'last_fiscal_year',
  'next_fiscal_year',
  'this_year',
  'last_year',
  'next_year',
  'this_fiscal_quarter',
  'last_fiscal_quarter',
  'next_fiscal_quarter',
  'this_quarter',
  'last_quarter',
  'next_quarter',
  'this_month',
  'last_month',
  'next_month',
];

interface Props {
  from: string | null;
  to: string | null;
  onChange: (from: string | null, to: string | null) => void;
  /** Smaller inline variant for table rows. */
  compact?: boolean;
}

const fmt = (iso: string) => new Date(iso + 'T00:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

/**
 * Effective-period picker: a preset (resolved to concrete dates at pick time,
 * so the plan's meaning doesn't drift as the calendar moves), always, or a
 * custom range.
 */
export function PeriodPicker({ from, to, onChange, compact }: Props) {
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [custom, setCustom] = useState(false);
  useEffect(() => {
    loadConfig().then(setCfg);
  }, []);

  const ranges = PRESETS.map((p) => {
    const [a, b] = resolveRelativeRange(p, undefined, { fiscalYearStartMonth: cfg?.fiscalYearStartMonth ?? 1, weekStartsOn: cfg?.weekStartsOn ?? 1 });
    return { preset: p, from: formatDateMs(a, 'date'), to: formatDateMs(b, 'date') };
  });
  const match = ranges.find((r) => r.from === from && r.to === to);
  const value = custom ? 'custom' : !from && !to ? 'always' : match ? match.preset : 'custom';
  const showCustom = value === 'custom';

  return (
    <span className={`inline-flex flex-wrap items-center gap-1 ${compact ? '' : 'text-xs'}`}>
      <select
        className="select"
        value={value}
        onChange={(e) => {
          const v = e.target.value;
          if (v === 'always') {
            setCustom(false);
            onChange(null, null);
          } else if (v === 'custom') {
            setCustom(true);
          } else {
            setCustom(false);
            const r = ranges.find((x) => x.preset === v)!;
            onChange(r.from, r.to);
          }
        }}
      >
        <option value="always">Always</option>
        {ranges.map((r) => (
          <option key={r.preset} value={r.preset}>
            {RELATIVE_LABELS[r.preset]} ({fmt(r.from)} – {fmt(r.to)})
          </option>
        ))}
        <option value="custom">Custom range…</option>
      </select>
      {showCustom && (
        <>
          <input type="date" className="input" value={from ?? ''} onChange={(e) => onChange(e.target.value || null, to)} />
          <span className="text-slate-400">→</span>
          <input type="date" className="input" value={to ?? ''} onChange={(e) => onChange(from, e.target.value || null)} />
        </>
      )}
      {!showCustom && match && !compact && (
        <span className="text-slate-400">
          {fmt(match.from)} – {fmt(match.to)}
        </span>
      )}
    </span>
  );
}
