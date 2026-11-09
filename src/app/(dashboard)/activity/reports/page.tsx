export const dynamic = 'force-dynamic'

import { requireOwner } from '@/lib/auth/page-owner'
import Link from 'next/link'
import { FileText } from 'lucide-react'
import { activeAccountErrorCode, resolveOnlyActiveAccount, type ActiveAccountErrorCode } from '@/lib/accounts/active-account'
import { getAdminClient } from '@/lib/supabase/admin'
import { resolveRange, rangeTitle, type ResolvedRangeFull } from '@/lib/date-range'
import { ActiveAccountUnavailableNotice } from '@/components/accounts/ActiveAccountUnavailableNotice'
import { PageHeader } from '@/components/layout/PageHeader'
import { EmptyState } from '@/components/ui/empty-state'
import { LowDataNotice } from '@/components/ui/LowDataNotice'
import { UrlDateRangeControl } from '@/components/ui/UrlDateRangeControl'

interface DailyReportHistoryRow {
  report_date: string
  model_used: string | null
}

interface HistoryRead {
  rows: DailyReportHistoryRow[]
  range: ResolvedRangeFull
  accountErrorCode: ActiveAccountErrorCode | null
  readFailed: boolean
}

async function readHistory(params: { range?: string; from?: string; to?: string }): Promise<HistoryRead> {
  const range = resolveRange(params, '1m')
  const db = getAdminClient()
  const active = await resolveOnlyActiveAccount(db)
  if (!active.ok) return { rows: [], range, accountErrorCode: activeAccountErrorCode(active.reason), readFailed: false }

  const { data, error } = await db
    .from('daily_reports')
    .select('report_date, model_used')
    .eq('ad_account_id', active.account.id)
    .gte('report_date', range.from)
    .lte('report_date', range.to)
    .order('report_date', { ascending: false })
    .limit(62)

  return { rows: (data ?? []) as DailyReportHistoryRow[], range, accountErrorCode: null, readFailed: Boolean(error) }
}

function displayDate(value: string): string {
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${value}T00:00:00Z`))
}

export default async function ReportsPage({ searchParams }: {
  searchParams: Promise<{ range?: string; from?: string; to?: string }>
}) {
  await requireOwner()

  const data = await readHistory(await searchParams)

  return (
    <div className="space-y-6 max-w-5xl">
      <PageHeader
        title="Daily report history"
        icon={FileText}
        subtitle="Stored daily snapshots from prior syncs. Open a date to inspect its original report and evidence."
        controls={<UrlDateRangeControl value={{ preset: data.range.preset, from: data.range.from, to: data.range.to }} />}
      />

      {data.accountErrorCode ? (
        <ActiveAccountUnavailableNotice code={data.accountErrorCode} />
      ) : data.readFailed ? (
        <LowDataNotice title="Report history unavailable" message="The stored daily reports could not be read. This is unavailable, not an empty history." tone="warning" />
      ) : data.rows.length === 0 ? (
        <div className="card-base">
          <EmptyState icon={FileText} title="No reports in this period" description={`No stored daily reports were found for ${rangeTitle(data.range)}.`} tone="info" />
        </div>
      ) : (
        <section className="card-base overflow-hidden" aria-labelledby="daily-report-history-title">
          <div className="border-b border-[var(--border)] px-5 py-3">
            <h2 id="daily-report-history-title" className="section-label">Daily reports · {rangeTitle(data.range)}</h2>
            <p className="mt-1 text-xs text-[var(--text-tertiary)]">Showing up to the latest 62 stored snapshots within this selected period.</p>
          </div>
          <div className="overflow-x-auto" role="region" aria-label="Daily report history" tabIndex={0}>
            <table className="data-table">
              <thead><tr><th>Date</th><th>Status</th><th><span className="sr-only">Open report</span></th></tr></thead>
              <tbody>{data.rows.map((row) => (
                <tr key={row.report_date}>
                  <td className="text-[var(--text-primary)]">{displayDate(row.report_date)}</td>
                  <td className="text-xs text-[var(--text-tertiary)]">{row.model_used && row.model_used !== 'none' ? 'Full report' : 'Metrics only'}</td>
                  <td className="text-right"><Link className="inline-flex min-h-11 items-center text-sm font-medium text-[var(--accent)]" href={`/reports/${row.report_date}`}>View report</Link></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  )
}
