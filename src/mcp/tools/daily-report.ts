import { ToolInputError } from '@/lib/security/api-error'
import { getSupabaseClient } from '../lib/supabase'
import { checkRateLimit } from '../lib/rate-limit'
import { nyDaysAgo } from '@/lib/utils/date-utils'
import { getRecLineageStatus, lineageNotice } from '@/lib/flags/generations'
import { projectCurrentActionableTasks, projectStoredReport } from '@/lib/authority/diagnostic-surface'
import { activeAccountErrorCode, resolveOnlyActiveAccount } from '@/lib/accounts/active-account'

export async function getDailyReport(args: { date?: string }) {
  checkRateLimit('get_daily_report')

  const date = args.date || nyDaysAgo(1)

  // Validate date
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ToolInputError('date must be in YYYY-MM-DD format')
  }
  if (new Date(date) > new Date()) {
    throw new ToolInputError('date cannot be in the future')
  }

  const db = getSupabaseClient()
  const activeAccount = await resolveOnlyActiveAccount(db)
  if (!activeAccount.ok) {
    throw new Error(`${activeAccountErrorCode(activeAccount.reason)}: daily report is unavailable because active account ownership is ${activeAccount.reason}`)
  }
  const adAccountDbId = activeAccount.account.id

  // Get the report
  const { data: report, error } = await db
    .from('daily_reports')
    .select(
      'id, ad_account_id, report_date, summary_text, full_report_md, report_json, money_basis_version, total_spend, total_leads, total_bookings, avg_cpl, avg_cpb, generated_at, recommendation_generation_id'
    )
    .eq('ad_account_id', adAccountDbId)
    .eq('report_date', date)
    .maybeSingle()

  if (error) throw new Error(`Daily report query failed: ${error.message}`)
  if (!report) {
    return {
      error: 'NO_REPORT_FOUND',
      message: `No daily report found for ${date}. Run a sync first, or check if the date has data.`,
      date,
    }
  }

  const safeReport = projectStoredReport(report as unknown as Record<string, unknown>)

  // Report lineage, read-time: flag a PRESERVED report whose pinned recommendation generation is no
  // longer lineage-current (a newer flag run committed while its rec commit failed), so an agent reading
  // this report never treats last-known-complete recs as the newest run's current proof.
  const lineage = await getRecLineageStatus(db, report.ad_account_id as string, report.recommendation_generation_id as string | null)

  // Get tasks linked to this report. report_id is the report's UUID (audit_tasks.report_id FK), NOT the
  // date — the old report_date comparison type-errored and silently returned no tasks.
  const { data: tasks, error: tasksError } = await db
    .from('audit_tasks')
    .select('title, description, priority, status, due_date, recommendation, action_decision:action_decisions(authority_tier, policy_version, authority_reason, owner_copy)')
    .eq('ad_account_id', adAccountDbId)
    .eq('report_id', report.id)
    .order('priority', { ascending: false })
    .limit(100)
  if (tasksError) throw new Error(`Daily report task query failed: ${tasksError.message}`)

  return {
    date: report.report_date,
    generated_at: report.generated_at,
    summary: safeReport.summary_text,
    full_report: safeReport.full_report_md,
    key_metrics: {
      total_spend: report.total_spend,
      total_leads: report.total_leads,
      total_bookings: report.total_bookings,
      avg_cost_per_lead: report.avg_cpl,
      avg_cost_per_booking: report.avg_cpb,
    },
    // Report lineage — the SAME structured FIVE-state lineage every consumer exposes (page/API/MCP):
    // state is always present so an agent never assumes "current" on an unverifiable read; notice is
    // the deterministic shared copy (null only for 'current').
    recommendation_lineage: { state: lineage.state, committed_at: lineage.committedAt, notice: lineageNotice(lineage) },
    tasks: projectCurrentActionableTasks((tasks || []) as Array<Record<string, unknown>>).slice(0, 20),
  }
}
