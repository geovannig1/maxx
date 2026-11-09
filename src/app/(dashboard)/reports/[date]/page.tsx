export const dynamic = 'force-dynamic'

import { accountCurrency } from '@/config/business-config'
import { requireOwner } from '@/lib/auth/page-owner'
import { getAdminClient } from '@/lib/supabase/admin'
import { getRecLineageStatus } from '@/lib/flags/generations'
import { LineageNotice } from '@/components/report/LineageNotice'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { format, subDays, addDays, parseISO } from 'date-fns'
import { ChevronLeft, ChevronRight, FileText } from 'lucide-react'
import { nyToday } from '@/lib/utils/date-utils'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { ReportNarrative } from '@/components/report/ReportNarrative'
import { ReportActions } from './ReportActions'
import { projectCurrentActionableTasks, projectStoredReport } from '@/lib/authority/diagnostic-surface'
import { activeAccountErrorCode, resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { ActiveAccountUnavailableNotice } from '@/components/accounts/ActiveAccountUnavailableNotice'
import { OwnerDiagnosticsPanel } from '@/components/diagnostics/OwnerDiagnosticsPanel'
import { readOwnerDiagnosticsSnapshot } from '@/lib/diagnostics/owner-surface'
import { outcomeWords } from '@/config/outcome-nouns'
import { collectedValueNote, readReportSourceCompleteness } from '@/lib/outcomes/report-gate'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

interface PageProps {
  params: Promise<{ date: string }>
}

interface ReportRow {
  id: string
  ad_account_id: string
  report_date: string
  total_spend: number | null
  total_leads: number | null
  total_bookings: number | null
  business_outcomes: number | null
  business_revenue: number | null
  money_basis_version: number | null
  business_revenue_basis: string | null
  outcome_source_available: boolean | null
  business_revenue_complete: boolean | null
  collected_value_lower_bound: number | null
  collected_value_covered_outcomes: number | null
  collected_value_total_outcomes: number | null
  avg_cpb: number | null
  full_report_md: string | null
  summary_text: string | null
  generated_at: string
  model_used: string | null
  recommendation_generation_id: string | null
  report_json: Record<string, unknown> | null
}

interface TaskRow {
  id: string
  title: string
  status: string
  priority: string
  recommendation: string | null
  due_date: string | null
}

async function getReport(date: string) {
  const db = getAdminClient()
  const activeAccount = await resolveOnlyActiveAccount(db)
  if (!activeAccount.ok) {
    return {
      report: null,
      tasks: [] as TaskRow[],
      lineage: { state: 'no_snapshot' as const, committedAt: null, parentFlagGeneration: null },
      accountErrorCode: activeAccountErrorCode(activeAccount.reason),
    }
  }
  const accountId = activeAccount.account.id

  const baselineColumns = 'id, ad_account_id, report_date, total_spend, total_leads, total_bookings, business_outcomes, business_revenue, avg_cpb, full_report_md, summary_text, generated_at, model_used, recommendation_generation_id, report_json'
  const moneyColumns = 'money_basis_version, business_revenue_basis, outcome_source_available, business_revenue_complete, collected_value_lower_bound, collected_value_covered_outcomes, collected_value_total_outcomes'
  const read = (columns: string) => db
    .from('daily_reports')
    .select(columns)
    .eq('ad_account_id', accountId)
    .eq('report_date', date)
    .maybeSingle()
  let { data: report, error: reportError } = await read(`${baselineColumns}, ${moneyColumns}`)
  if (reportError && /does not exist|not exist|unknown column|undefined column/i.test(reportError.message)) {
    const baseline = await read(baselineColumns)
    report = baseline.data
    reportError = baseline.error
  }
  if (reportError) throw new Error(`daily report read failed for ${date}: ${reportError.message}`)
  const typedReport = report as unknown as ReportRow | null

  // Report lineage, evaluated at READ time so a PRESERVED report is labeled too: is this report's
  // recommendation generation still lineage-current, or last-known-complete (a newer flag run committed
  // while its rec commit failed)?
  const lineage = typedReport
    ? await getRecLineageStatus(db, accountId, typedReport.recommendation_generation_id)
    : { state: 'no_snapshot' as const, committedAt: null, parentFlagGeneration: null }

  // Scope tasks to THIS report (audit_tasks.report_id) — previously this pulled the 20 most-recent
  // tasks globally, so the same tasks showed under every date.
  let tasks: TaskRow[] = []
  if (typedReport?.id) {
    const { data } = await db
      .from('audit_tasks')
      .select('id, title, status, priority, recommendation, due_date, action_decision:action_decisions(authority_tier, policy_version, authority_reason, owner_copy)')
      .eq('ad_account_id', accountId)
      .eq('report_id', typedReport.id)
      .order('created_at', { ascending: false })
      .limit(100)
    tasks = projectCurrentActionableTasks((data ?? []) as Array<Record<string, unknown>>).slice(0, 20) as unknown as TaskRow[]
  }

  return {
    report: typedReport ? projectStoredReport(typedReport as unknown as Record<string, unknown>) as unknown as ReportRow : null,
    tasks,
    lineage,
    accountErrorCode: null,
  }
}

function formatCurrency(value: number | null, currency = accountCurrency()): string {
  if (value === null || value === undefined) return '—'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
  }).format(value)
}

const PRIORITY_COLORS: Record<string, React.CSSProperties> = {
  urgent: { background: 'var(--danger-bg)', color: 'var(--danger)', border: '1px solid var(--danger-border)' },
  high:   { background: 'var(--warning-bg)', color: 'var(--warning)', border: '1px solid var(--warning-border)' },
  medium: { background: 'var(--info-bg)', color: 'var(--info)', border: '1px solid var(--info-border)' },
  low:    { background: 'var(--bg-subtle)', color: 'var(--text-tertiary)', border: '1px solid var(--border)' },
}

export default async function ReportPage({ params }: PageProps) {
  await requireOwner()

  const { date } = await params

  // A malformed date string is a real 404; a valid-format date with no report is an honest empty state.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) notFound()

  const { report, tasks, lineage, accountErrorCode } = await getReport(date)

  if (accountErrorCode) {
    return (
      <div className="max-w-3xl mx-auto">
        <ActiveAccountUnavailableNotice code={accountErrorCode} />
      </div>
    )
  }

  const parsedDate = parseISO(date)
  const prevDate = format(subDays(parsedDate, 1), 'yyyy-MM-dd')
  const nextDate = format(addDays(parsedDate, 1), 'yyyy-MM-dd')
  const today = nyToday()
  const isNextFuture = nextDate > today

  const navBtnStyle: React.CSSProperties = {
    padding: '6px', borderRadius: 'var(--r-md)',
    border: '1px solid var(--border)', color: 'var(--text-secondary)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    transition: 'border-color 80ms, color 80ms',
  }

  // Valid date, but no report exists for it — a report is generated only when a sync runs for that day.
  // Keep the day-to-day nav so adjacent (available) reports stay reachable, and link back to the hub.
  if (!report) {
    return (
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="flex items-center gap-3">
          <Link href={`/reports/${prevDate}`} style={navBtnStyle}>
            <ChevronLeft className="w-4 h-4" />
          </Link>
          <div>
            <h2 className="font-semibold text-base" style={{ color: 'var(--text-primary)' }}>
              {format(parsedDate, 'EEEE, MMMM d, yyyy')}
            </h2>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>Daily Performance Report</p>
          </div>
          {!isNextFuture && (
            <Link href={`/reports/${nextDate}`} style={navBtnStyle}>
              <ChevronRight className="w-4 h-4" />
            </Link>
          )}
        </div>
        <div className="card-base">
          <EmptyState
            icon={FileText}
            title="No report for this date"
            description="No daily report was generated for this day — reports are created when a sync runs for that date. Use the arrows to check the days on either side, or open the reports hub for the full calendar."
            tone="info"
          />
        </div>
        <div className="text-center">
          <Link href="/activity/reports" className="text-xs" style={{ color: 'var(--accent)', textDecoration: 'none' }}>
            ← Back to all reports
          </Link>
        </div>
      </div>
    )
  }

  // Metrics persist even when no LLM is configured; show that honestly instead of rendering the
  // placeholder narrative as if the report were broken.
  const metricsOnly = !report.model_used || report.model_used === 'none'
  const ownerDiagnostics = readOwnerDiagnosticsSnapshot(report.report_json?.ownerDiagnostics)
  // business_revenue_complete is collected-value coverage; the note states source completeness.
  const sourceCompleteness = readReportSourceCompleteness(report.report_json)
  const versionedMoney = report.money_basis_version === 1
    && report.business_revenue_basis === 'outcome_collected_value'
  const revenueKpi = !versionedMoney
    ? { label: 'Booked value (legacy)', value: formatCurrency(report.business_revenue) }
    : report.outcome_source_available !== true
      ? { label: `Amount paid · active ${OW.many}`, value: 'unavailable', sub: 'ledger source unavailable' }
      : report.business_revenue_complete === true
        ? { label: `Amount paid · active ${OW.many}`, value: formatCurrency(report.business_revenue), sub: collectedValueNote(OW, sourceCompleteness.completeness, sourceCompleteness.arrival) }
        : {
            label: `Amount paid · active ${OW.many}`,
            value: 'unavailable',
            sub: `${report.collected_value_covered_outcomes ?? 0}/${report.collected_value_total_outcomes ?? '—'} amount_paid covered · ${formatCurrency(report.collected_value_lower_bound)} observed lower bound`,
          }

  const openTasks = tasks.filter((t) => t.status !== 'done').length

  return (
    <div className="max-w-3xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href={`/reports/${prevDate}`} style={navBtnStyle}>
            <ChevronLeft className="w-4 h-4" />
          </Link>
          <div>
            <h2 className="font-semibold text-base" style={{ color: 'var(--text-primary)' }}>
              {format(parsedDate, 'EEEE, MMMM d, yyyy')}
            </h2>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>Daily performance report</p>
          </div>
          {!isNextFuture && (
            <Link href={`/reports/${nextDate}`} style={navBtnStyle}>
              <ChevronRight className="w-4 h-4" />
            </Link>
          )}
        </div>
        <ReportActions date={date} />
      </div>

      {/* Report lineage — DURABLE, read-time lineage, all FIVE states rendered deterministically
          (current = quiet caption; no_snapshot / last_known_complete / unknown = toned banners).
          Date-scoped and computed on read, so a PRESERVED report is labeled even though its narrative
          was written before it went stale. */}
      <LineageNotice status={lineage} />

      {/* TL;DR — Maxx's one-paragraph read of the day. The report already writes this; it was never shown. */}
      {report.summary_text && (
        <div className="card-base p-5">
          <p className="section-label mb-2">Maxx&apos;s read</p>
          <p style={{ fontSize: 15, lineHeight: 1.6, color: 'var(--text-primary)', textWrap: 'pretty' }}>{report.summary_text}</p>
        </div>
      )}

      {/* KPI row + the source-of-truth caption stated ONCE, right where the numbers are. */}
      <div className="card-base p-5">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-6">
          {[
            { label: 'Spend', value: formatCurrency(report.total_spend as number | null) },
            { label: 'Leads', value: (report.total_leads as number | null)?.toString() ?? '—' },
            { label: 'Meta cost / Result', value: formatCurrency(report.avg_cpb as number | null) },
            { label: 'Meta Results (modelled 7dc/1dv)', value: (report.total_bookings as number | null)?.toString() ?? '—' },
            { label: `Real ${OW.many}`, value: (report.business_outcomes as number | null)?.toString() ?? '—' },
            revenueKpi,
          ].map(({ label, value, sub }) => (
            <div key={label}>
              <p className="section-label mb-1">{label}</p>
              <p className="text-xl font-bold tabular-nums" style={{ color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>{value}</p>
              {sub && <p className="text-[11px] mt-1" style={{ color: 'var(--text-tertiary)' }}>{sub}</p>}
            </div>
          ))}
        </div>
        <p className="text-xs mt-4" style={{ color: 'var(--text-tertiary)' }}>
          Value-bearing {OW.many}, scheduled booked value, and amount paid on active {OW.many} come from the outcome ledger (all sources). Amount paid is an active-{OW.one} measure only. Older stored reports that predate this field are explicitly labeled legacy booked value. Meta Results and Meta cost / Result are
          modelled attribution estimates. GA4 confirmation events are web telemetry, not {OW.many} or revenue. These
          planes measure different populations; no fixed higher/lower ordering is assumed.
        </p>
      </div>

      {/* Metrics-only banner — the report exists, just without an LLM narrative. Not "broken." */}
      {metricsOnly && (
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: '10px',
            padding: '11px 15px', borderRadius: '10px', fontSize: '12.5px',
            background: 'var(--info-bg)', border: '1px solid var(--info-border)', color: 'var(--info)',
          }}
        >
          Metrics are available. The written narrative is paused until an LLM key is configured.
        </div>
      )}

      <OwnerDiagnosticsPanel diagnostics={ownerDiagnostics} />

      {/* What to do — tasks lifted ABOVE the narrative so the action isn't buried under the detail. */}
      {tasks.length > 0 ? (
        <div className="card-base overflow-hidden">
          <div className="px-5 py-3 flex items-center justify-between" style={{ borderBottom: '1px solid var(--border)' }}>
            <p className="section-label">What to do next</p>
            <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{openTasks} open · {tasks.length} total</span>
          </div>
          <div>
            {tasks.map((task) => (
              <div key={task.id} className="flex items-start gap-3 px-5 py-3.5" style={{ borderTop: '1px solid var(--border)' }}>
                <Badge variant="outline" className="text-xs shrink-0" style={PRIORITY_COLORS[task.priority] ?? {}}>
                  {task.priority}
                </Badge>
                <div className="flex-1 min-w-0 space-y-0.5">
                  <p className="text-sm" style={{ color: 'var(--text-primary)' }}>{task.title}</p>
                  {task.recommendation && (
                    <p className="text-xs line-clamp-2" style={{ color: 'var(--text-secondary)' }}>{task.recommendation}</p>
                  )}
                  {task.due_date && (
                    <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                      Due {format(parseISO(task.due_date), 'MMM d')}
                    </p>
                  )}
                </div>
                <Badge
                  variant="outline"
                  className="text-xs shrink-0"
                  style={
                    task.status === 'done'
                      ? { background: 'var(--success-bg)', color: 'var(--success)', border: '1px solid var(--success-border)' }
                      : task.status === 'in_progress'
                      ? { background: 'var(--info-bg)', color: 'var(--info)', border: '1px solid var(--info-border)' }
                      : { background: 'var(--bg-subtle)', color: 'var(--text-tertiary)', border: '1px solid var(--border)' }
                  }
                >
                  {task.status.replaceAll('_', ' ')}
                </Badge>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="card-base p-5">
          <p className="section-label mb-1">What to do next</p>
          <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
            Nothing was flagged from this report — no action needed from this day.
          </p>
        </div>
      )}

      {/* The detail — the narrative, now split into scannable titled sections (was a raw markdown wall). */}
      {!metricsOnly && report.full_report_md && (
        <div className="space-y-2">
          <p className="section-label px-1">The detail</p>
          <ReportNarrative md={report.full_report_md as string} />
        </div>
      )}
    </div>
  )
}
