// Small pieces shared by the accounting pages.
import type { ReactNode } from 'react';
import type { JournalEntry } from '../../api';

export const money = (n: number | null | undefined) => (n === null || n === undefined ? '' : n.toLocaleString(undefined, { style: 'currency', currency: 'USD' }));
export const monthLabel = (ym: string) => new Date(`${ym}-01T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' });
export const addMonths = (ym: string, n: number) => {
  const [y, m] = ym.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};

export function PageHeader({ section, title, children, hint }: { section: string; title: string; children?: ReactNode; hint?: ReactNode }) {
  return (
    <div className="border-b border-slate-200 px-6 py-4">
      <div className="text-xs text-slate-400">{section}</div>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold">{title}</h1>
        <div className="flex-1" />
        {children}
      </div>
      {hint && <p className="mt-1 max-w-3xl text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'warn' | 'good' }) {
  const text = tone === 'warn' ? 'text-amber-700' : tone === 'good' ? 'text-emerald-700' : 'text-slate-800';
  return (
    <div className="rounded-lg border border-slate-200 bg-panel px-3 py-2">
      <div className="text-xs text-slate-400">{label}</div>
      <div className={`text-lg font-semibold ${text}`}>{value}</div>
      {sub && (
        <div className="truncate text-[11px] text-slate-400" title={sub}>
          {sub}
        </div>
      )}
    </div>
  );
}

export function ErrorBar({ error, onDismiss }: { error: string | null; onDismiss: () => void }) {
  if (!error) return null;
  return (
    <div className="border-b border-red-200 bg-red-50 px-6 py-1.5 text-xs text-red-700">
      {error}{' '}
      <button className="underline" onClick={onDismiss}>
        dismiss
      </button>
    </div>
  );
}

export function Warnings({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
      {items.map((w, i) => (
        <div key={i}>{w}</div>
      ))}
    </div>
  );
}

const KIND_LABEL: Record<string, string> = { accrual: 'Accrual', amortization: 'Amortization', impairment: 'Write-off', reclass: 'Reclass' };

export function JournalTable({ entries, empty = 'No entries.' }: { entries: JournalEntry[]; empty?: string }) {
  return (
    <table className="w-full bg-panel text-xs">
      <thead className="text-left text-slate-400">
        <tr className="border-b border-slate-200">
          <th className="py-1.5 pr-3 font-normal">Type</th>
          <th className="py-1.5 pr-3 font-normal">Memo</th>
          <th className="py-1.5 pr-3 font-normal">Account</th>
          <th className="py-1.5 pr-3 font-normal">Department</th>
          <th className="py-1.5 pr-3 text-right font-normal">Debit</th>
          <th className="py-1.5 text-right font-normal">Credit</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((e, i) => {
          const dr = e.lines.reduce((a, l) => a + l.debit, 0);
          const cr = e.lines.reduce((a, l) => a + l.credit, 0);
          const balanced = Math.round(dr * 100) === Math.round(cr * 100);
          return [
            ...e.lines.map((l, j) => (
              <tr key={`${i}-${j}`} className={`border-b border-slate-100 ${j === 0 ? 'border-t border-t-slate-300' : ''}`}>
                <td className="py-1 pr-3 whitespace-nowrap">{j === 0 ? <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600">{KIND_LABEL[e.kind ?? ''] ?? 'Entry'}</span> : ''}</td>
                <td className="py-1 pr-3 text-slate-500">{j === 0 ? e.memo : ''}</td>
                <td className={`py-1 pr-3 ${l.credit ? 'pl-6' : ''}`}>
                  {l.accountNumber && <span className="mr-1.5 font-mono text-[11px] text-slate-400">{l.accountNumber}</span>}
                  {l.account}
                </td>
                <td className="py-1 pr-3">{l.department ?? ''}</td>
                <td className="py-1 pr-3 text-right">{l.debit ? money(l.debit) : ''}</td>
                <td className="py-1 text-right">{l.credit ? money(l.credit) : ''}</td>
              </tr>
            )),
            <tr key={`${i}-t`} className="text-[11px] text-slate-400">
              <td colSpan={4} className="py-0.5 pr-3 text-right">
                {balanced ? 'Balanced' : <span className="text-rose-700">Out of balance</span>}
              </td>
              <td className="py-0.5 pr-3 text-right">{money(dr)}</td>
              <td className="py-0.5 text-right">{money(cr)}</td>
            </tr>,
          ];
        })}
        {entries.length === 0 && (
          <tr>
            <td colSpan={6} className="py-4 text-center text-slate-400">
              {empty}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

/** A tiny bar chart of monthly amounts (method previews, waterfalls). */
export function Bars({ data, height = 64 }: { data: { label: string; value: number }[]; height?: number }) {
  const max = Math.max(1, ...data.map((d) => Math.abs(d.value)));
  return (
    <div className="flex items-end gap-px" style={{ height }} role="img" aria-label="Amortization by month">
      {data.map((d) => (
        <div
          key={d.label}
          className="min-w-[2px] flex-1 rounded-t-sm bg-indigo-500/80 hover:bg-indigo-400"
          style={{ height: `${Math.max(2, (Math.abs(d.value) / max) * 100)}%` }}
          title={`${d.label}: ${money(d.value)}`}
        />
      ))}
    </div>
  );
}
