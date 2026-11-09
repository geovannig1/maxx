// Light chart palette (design tokens → Charts). LITERALS on purpose: Recharts passes these into SVG
// attributes (stopColor, stroke, fill) where CSS var() does not resolve — everything else in the
// app uses var(--token); charts alone pin the resolved values. Keep in sync with globals.css.
export const CHART = {
  primary: '#6366F1', // series line/area (indigo-500 — reads crisper on white than the UI accent 600)
  comparison: '#9CA3AF', // prior-period series
  grid: '#EEF0F3',
  axisText: '#6B7280', // = --text-tertiary
  cursor: '#4F46E5',
  dotOutline: '#FFFFFF',
  tooltipBg: '#FFFFFF',
  tooltipBorder: '#E5E7EB',
  tooltipText: '#111827',
  tooltipMuted: '#6B7280',
  success: '#059669',
  warning: '#D97706',
  danger: '#DC2626',
  empty: '#F3F4F6', // empty cells / placeholder bars
} as const

/** Shared tooltip container style (a white card, not a dark panel). */
export const CHART_TOOLTIP_STYLE: React.CSSProperties = {
  background: CHART.tooltipBg,
  border: `1px solid ${CHART.tooltipBorder}`,
  borderRadius: 8,
  color: CHART.tooltipText,
  padding: '8px 12px',
  boxShadow: '0 4px 16px -4px rgba(16,24,40,0.10)',
}
