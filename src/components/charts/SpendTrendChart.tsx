'use client'
import { accountCurrency } from '@/config/business-config'
import { formatMoney, formatMoneyTrim } from '@/lib/utils/format-currency'

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
} from 'recharts'
import { format, parseISO } from 'date-fns'
import { CHART, CHART_TOOLTIP_STYLE } from './theme'

interface SpendTrendChartProps {
  data: Array<{ date: string; spend: number }>
  currency?: string
}

function formatYAxis(value: number, currency = accountCurrency()): string {
  if (value >= 1000) return formatMoney(value, { currency, compact: true, maximumFractionDigits: 1 })
  return formatMoneyTrim(value, { currency })
}

function formatXAxis(dateStr: string): string {
  try {
    return format(parseISO(dateStr), 'MMM d')
  } catch {
    return dateStr
  }
}

function formatTooltipValue(value: number, currency = accountCurrency()): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
  }).format(value)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function CustomTooltip({ active, payload, label, currency }: any) {
  if (!active || !payload?.length) return null
  return (
    <div style={{ ...CHART_TOOLTIP_STYLE }}>
      <p style={{ fontSize: '11px', color: CHART.tooltipMuted, marginBottom: '3px' }}>
        {label ? formatXAxis(label) : ''}
      </p>
      <p style={{ fontSize: '13px', fontWeight: 600, color: CHART.tooltipText }}>
        {formatTooltipValue(payload[0].value, currency)}
      </p>
    </div>
  )
}

export function SpendTrendChart({ data, currency = accountCurrency() }: SpendTrendChartProps) {
  if (!data || data.length === 0) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '13px', color: 'var(--text-tertiary)' }}>
        No spend data available
      </div>
    )
  }

  return (
    <ResponsiveContainer width="100%" height="100%" minHeight={80}>
      <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id="spendGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={CHART.primary} stopOpacity={0.25} />
            <stop offset="95%" stopColor={CHART.primary} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} vertical={false} />
        <XAxis
          dataKey="date"
          tickFormatter={formatXAxis}
          tick={{ fill: CHART.axisText, fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          dy={8}
        />
        <YAxis
          tickFormatter={(value: number) => formatYAxis(value, currency)}
          tick={{ fill: CHART.axisText, fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          width={48}
        />
        <Tooltip
          content={<CustomTooltip currency={currency} />}
          cursor={{ stroke: CHART.cursor, strokeWidth: 1, strokeDasharray: '4 4' }}
        />
        <Area
          type="monotone"
          dataKey="spend"
          stroke={CHART.primary}
          strokeWidth={2}
          fill="url(#spendGradient)"
          dot={false}
          activeDot={{ r: 4, fill: CHART.primary, stroke: CHART.dotOutline, strokeWidth: 2 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}
