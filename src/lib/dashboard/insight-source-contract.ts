export interface InsightSpendRow {
  date_start?: unknown
  spend?: unknown
}

export interface DashboardSpendTrendRow {
  report_date: string
  total_spend: number
}

function finiteNumber(value: unknown): number {
  const n = Number(value ?? 0)
  return Number.isFinite(n) ? n : 0
}

export function accountInsightSpendTrend(rows: ReadonlyArray<InsightSpendRow>): DashboardSpendTrendRow[] {
  const byDate = new Map<string, number>()
  for (const row of rows) {
    if (typeof row.date_start !== 'string') continue
    byDate.set(row.date_start, (byDate.get(row.date_start) ?? 0) + finiteNumber(row.spend))
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([report_date, total_spend]) => ({ report_date, total_spend }))
}

export function accountInsightSpendPacing(
  rows: ReadonlyArray<InsightSpendRow>,
  startDate: string,
): { recentSpend: number; daysOfData: number } {
  const trend = accountInsightSpendTrend(rows).filter((row) => row.report_date >= startDate)
  return {
    recentSpend: trend.reduce((sum, row) => sum + row.total_spend, 0),
    daysOfData: trend.filter((row) => row.total_spend > 0).length,
  }
}
