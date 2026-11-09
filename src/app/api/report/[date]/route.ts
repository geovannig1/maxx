import { ownerOnly } from '@/lib/auth/require-owner'
import { createClient } from '@/lib/supabase/server'
import { getAdminClient } from '@/lib/supabase/admin'
import { getRecLineageStatus, lineageNotice } from '@/lib/flags/generations'
import { nyToday } from '@/lib/utils/date-utils'
import { projectCurrentActionableTasks, projectStoredReport } from '@/lib/authority/diagnostic-surface'
import {
  activeAccountErrorCode,
  activeAccountErrorStatus,
  resolveOnlyActiveAccount,
} from '@/lib/accounts/active-account'
import { apiErrorResponse } from '@/lib/security/api-error'

export const runtime = 'nodejs'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// GET /api/report/[date]
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ date: string }> }
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden

  const { date } = await params

  // Validate date format
  if (!DATE_RE.test(date)) {
    return Response.json(
      { error: 'Invalid date format. Expected YYYY-MM-DD' },
      { status: 400 }
    )
  }

  // Reject future dates
  const today = nyToday()
  if (date > today) {
    return Response.json(
      { error: 'Cannot request reports for future dates' },
      { status: 400 }
    )
  }

  const adminClient = getAdminClient()
  const activeAccount = await resolveOnlyActiveAccount(adminClient)
  if (!activeAccount.ok) {
    return Response.json(
      {
        error: 'Active ad account scope is unavailable',
        code: activeAccountErrorCode(activeAccount.reason),
      },
      { status: activeAccountErrorStatus(activeAccount.reason) },
    )
  }
  const accountUuid = activeAccount.account.id

  // Look up existing report
  const { data: report, error: reportError } = await adminClient
    .from('daily_reports')
    .select('*')
    .eq('ad_account_id', accountUuid)
    .eq('report_date', date)
    .maybeSingle()

  if (reportError) {
    return apiErrorResponse('GET /api/report/[date]', 'REPORT_READ_FAILED', reportError, 500)
  }

  // If report exists, also fetch associated audit tasks and return 200
  if (report) {
    const { data: tasks } = await adminClient
      .from('audit_tasks')
      .select('*, action_decision:action_decisions(authority_tier, policy_version, authority_reason, owner_copy)')
      .eq('ad_account_id', accountUuid)
      .eq('report_id', report.id)
      .order('priority', { ascending: false })

    // Report lineage — surface the read-time lineage state so an API consumer never treats a
    // preserved last-known-complete (or unverifiable) report as current. Date-scoped + FIVE-state (incl. rolled_back).
    const lineage = await getRecLineageStatus(adminClient, report.ad_account_id as string, report.recommendation_generation_id as string | null)

    return Response.json({
      data: projectStoredReport(report as Record<string, unknown>),
      tasks: projectCurrentActionableTasks((tasks ?? []) as Array<Record<string, unknown>>),
      lineage: { state: lineage.state, committed_at: lineage.committedAt, notice: lineageNotice(lineage) },
    }, { status: 200 })
  }

  // No report — check whether insights exist for this date
  const { count, error: insightsError } = await adminClient
    .from('daily_insights')
    .select('id', { count: 'exact', head: true })
    .eq('ad_account_id', accountUuid)
    .eq('date_start', date)

  if (insightsError) {
    return apiErrorResponse('GET /api/report/[date]', 'INSIGHTS_READ_FAILED', insightsError, 500)
  }

  if (!count || count === 0) {
    return Response.json(
      { error: 'No data available for this date' },
      { status: 404 }
    )
  }

  // V3 reports may only be committed inside the governed sync lifecycle, after the current Meta,
  // Outcome-source, setup and tracking source heads have been validated. Warehouse rows alone are not proof
  // that those sources were refreshed together, so this route never creates an out-of-band report.
  return Response.json(
    {
      error: 'Report generation requires a complete synchronized evidence run.',
      code: 'REPORT_GENERATION_REQUIRES_SYNC',
      report_date: date,
    },
    { status: 409 }
  )
}
