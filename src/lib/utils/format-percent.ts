export function formatPercent(
  value: number | null | undefined,
  decimals = 2
): string {
  if (value == null) return '—'
  return `${value.toFixed(decimals)}%`
}

export function formatDelta(
  value: number | null | undefined
): { text: string; direction: 'up' | 'down' | 'flat' } {
  if (value == null) return { text: '—', direction: 'flat' }
  const text = `${value > 0 ? '+' : ''}${value.toFixed(1)}%`
  const direction: 'up' | 'down' | 'flat' =
    value > 0 ? 'up' : value < 0 ? 'down' : 'flat'
  return { text, direction }
}
