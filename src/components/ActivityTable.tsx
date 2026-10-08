import React from 'react';
import type { ActivityImport, ActivityType } from '../types';

interface Props {
  activities: ActivityImport[];
  onChange: (activities: ActivityImport[]) => void;
}

const TYPE_COLORS: Partial<Record<ActivityType, string>> = {
  BUY:          'bg-green-100  text-green-800  dark:bg-green-900  dark:text-green-200',
  SELL:         'bg-red-100    text-red-800    dark:bg-red-900    dark:text-red-200',
  DIVIDEND:     'bg-blue-100   text-blue-800   dark:bg-blue-900   dark:text-blue-200',
  DEPOSIT:      'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200',
  WITHDRAWAL:   'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
  INTEREST:     'bg-cyan-100   text-cyan-800   dark:bg-cyan-900   dark:text-cyan-200',
  FEE:          'bg-amber-100  text-amber-800  dark:bg-amber-900  dark:text-amber-200',
  TAX:          'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
  SPLIT:        'bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200',
  TRANSFER_IN:  'bg-teal-100   text-teal-800   dark:bg-teal-900   dark:text-teal-200',
  TRANSFER_OUT: 'bg-rose-100   text-rose-800   dark:bg-rose-900   dark:text-rose-200',
  CREDIT:       'bg-lime-100   text-lime-800   dark:bg-lime-900   dark:text-lime-200',
  ADJUSTMENT:   'bg-slate-100  text-slate-800  dark:bg-slate-900  dark:text-slate-200',
  UNKNOWN:      'bg-gray-100   text-gray-800   dark:bg-gray-900   dark:text-gray-200',
};

function Badge({ type }: { type: ActivityType }) {
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-semibold whitespace-nowrap ${TYPE_COLORS[type] ?? ''}`}>
      {type}
    </span>
  );
}

function toNum(v: number | string | null | undefined): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return parseFloat(v) || 0;
  return 0;
}

function fmtDate(d: Date | string | undefined): string {
  if (!d) return '';
  return (d instanceof Date ? d.toISOString() : d).slice(0, 10);
}

function fmtTime(d: Date | string | undefined): string {
  if (!d) return '';
  const s = d instanceof Date ? d.toISOString() : d;
  // ISO datetime: "2020-04-21T09:30:00+02:00" → "09:30"
  const t = s.slice(11, 16);
  return t.includes(':') ? t : '';
}

export default function ActivityTable({ activities, onChange }: Props) {
  function updateSymbol(index: number, value: string) {
    const next = activities.map((a, i) =>
      i === index ? { ...a, symbol: value, isValid: value.trim() !== '' } : a,
    );
    onChange(next);
  }

  const invalidCount = activities.filter(a => !a.isValid).length;

  return (
    <div className="space-y-2">
      {invalidCount > 0 && (
        <p className="text-sm text-amber-600 dark:text-amber-400 font-medium">
          ⚠ {invalidCount} {invalidCount === 1 ? 'row needs' : 'rows need'} a symbol — edit the cells highlighted in amber.
        </p>
      )}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/50 text-muted-foreground text-xs uppercase tracking-wide">
              <th className="px-3 py-2 text-left whitespace-nowrap">Date</th>
              <th className="px-3 py-2 text-left whitespace-nowrap">Time</th>
              <th className="px-3 py-2 text-left">Type</th>
              <th className="px-3 py-2 text-left">Symbol / ISIN</th>
              <th className="px-3 py-2 text-right whitespace-nowrap">Qty</th>
              <th className="px-3 py-2 text-right whitespace-nowrap">Unit price</th>
              <th className="px-3 py-2 text-left">Ccy</th>
              <th className="px-3 py-2 text-right">Fee</th>
              <th className="px-3 py-2 text-right">Tax</th>
              <th className="px-3 py-2 text-right">Amount</th>
              <th className="px-3 py-2 text-left">Comment</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {activities.map((a, i) => {
              const qty   = toNum(a.quantity);
              const price = toNum(a.unitPrice);
              const fee   = toNum(a.fee);
              const tax   = toNum(a.tax);
              const amt   = toNum(a.amount);
              return (
                <tr
                  key={i}
                  className={a.isValid ? 'hover:bg-muted/20' : 'bg-amber-50 dark:bg-amber-950/30'}
                >
                  <td className="px-3 py-1.5 whitespace-nowrap font-mono text-xs text-muted-foreground">
                    {fmtDate(a.date)}
                  </td>
                  <td className="px-3 py-1.5 whitespace-nowrap font-mono text-xs text-muted-foreground">
                    {fmtTime(a.date)}
                  </td>
                  <td className="px-3 py-1.5">
                    <Badge type={a.activityType} />
                  </td>
                  <td className="px-3 py-1.5">
                    {/* Symbol is editable — needed when ISIN lookup fails */}
                    <input
                      className={[
                        'w-full min-w-[120px] bg-transparent font-mono text-xs rounded px-1',
                        'focus:outline-none focus:ring-1 focus:ring-primary',
                        a.isValid ? '' : 'ring-1 ring-amber-400',
                      ].join(' ')}
                      value={a.symbol ?? ''}
                      onChange={e => updateSymbol(i, e.target.value)}
                      aria-label="Symbol"
                    />
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-xs">
                    {formatQty(qty)}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-xs">
                    {price.toFixed(4)}
                  </td>
                  <td className="px-3 py-1.5 text-xs text-muted-foreground">
                    {a.currency}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-xs">
                    {fee > 0 ? fee.toFixed(2) : '—'}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-xs">
                    {tax > 0 ? tax.toFixed(2) : '—'}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-xs font-medium">
                    {amt.toFixed(2)}
                  </td>
                  <td className="px-3 py-1.5 text-xs text-muted-foreground max-w-[240px] truncate" title={a.comment ?? ''}>
                    {a.comment}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function formatQty(n: number): string {
  return n % 1 === 0 ? n.toFixed(0) : n.toFixed(4).replace(/\.?0+$/, '');
}
