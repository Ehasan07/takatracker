'use client';

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatMinor, toBengaliDigits } from '@hishab/shared';

/**
 * Every chart in the app, in one module, so `next/dynamic` can keep Recharts
 * out of the reports route's first load — the library is larger than the rest
 * of the page put together.
 *
 * Charts are fed raw poisha. Converting to taka and back would mean rounding a
 * float into money, which is the one thing this codebase never does; the axis
 * divides for display only and that number never returns to the ledger.
 */

const MONTHS_BN = [
  'জানু',
  'ফেব্রু',
  'মার্চ',
  'এপ্রি',
  'মে',
  'জুন',
  'জুলা',
  'আগ',
  'সেপ্ট',
  'অক্টো',
  'নভে',
  'ডিসে',
];

/** Recharts types tick and label values loosely; ours are always `YYYY-MM`. */
const bnMonth = (key: unknown): string => {
  if (typeof key !== 'string') return '';
  return MONTHS_BN[Number(key.slice(5, 7)) - 1] ?? key;
};

const axisTick = (minorValue: number | string): string => {
  if (typeof minorValue !== 'number') return '';
  return `${toBengaliDigits((minorValue / 100_000).toFixed(0))}k`;
};

const tooltipMoney = (value: unknown): string =>
  typeof value === 'number' ? formatMinor(value) : '';

const TOOLTIP_STYLE = {
  background: 'var(--hishab-surface)',
  border: '1px solid var(--hishab-rule)',
  borderRadius: 8,
  fontSize: 12,
} as const;

export interface TrendPoint {
  month: string;
  incomeMinor: number;
  expenseMinor: number;
  netMinor: number;
}

export function TrendChart({ data }: { data: TrendPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -12 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--hishab-rule)" vertical={false} />
        <XAxis
          dataKey="month"
          tickFormatter={bnMonth}
          tick={{ fontSize: 11, fill: 'var(--hishab-ink-muted)' }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          tickFormatter={axisTick}
          tick={{ fontSize: 11, fill: 'var(--hishab-ink-muted)' }}
          axisLine={false}
          tickLine={false}
          width={44}
        />
        <Tooltip formatter={tooltipMoney} labelFormatter={bnMonth} contentStyle={TOOLTIP_STYLE} />
        <Bar dataKey="incomeMinor" name="আয়" fill="#1F6F4A" radius={[3, 3, 0, 0]} />
        <Bar dataKey="expenseMinor" name="খরচ" fill="#A8342A" radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function CategoryPie({
  data,
  colours,
}: {
  data: { name: string; value: number }[];
  colours: readonly string[];
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>
        <Pie data={data} dataKey="value" innerRadius="55%" outerRadius="90%" paddingAngle={2}>
          {data.map((_, i) => (
            <Cell key={i} fill={colours[i % colours.length]} />
          ))}
        </Pie>
        <Tooltip formatter={tooltipMoney} contentStyle={TOOLTIP_STYLE} />
      </PieChart>
    </ResponsiveContainer>
  );
}
