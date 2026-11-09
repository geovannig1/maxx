import { getSupabaseClient } from '../lib/supabase'
import { sanitizeObject } from '../lib/sanitize'
import { checkRateLimit } from '../lib/rate-limit'
import { projectCurrentActionableTasks, projectDiagnosticAlert } from '@/lib/authority/diagnostic-surface'
import { activeAccountErrorCode, resolveOnlyActiveAccount } from '@/lib/accounts/active-account'

export async function getAlerts(args: {
  severity?: 'critical' | 'warning' | 'info'
  is_resolved?: boolean
  limit?: number
}) {
  checkRateLimit('get_alerts')
  const db = getSupabaseClient()
  const activeAccount = await resolveOnlyActiveAccount(db)
  if (!activeAccount.ok) {
    throw new Error(`${activeAccountErrorCode(activeAccount.reason)}: alerts are unavailable because active account ownership is ${activeAccount.reason}`)
  }

  let query = db
    .from('alerts')
    .select(
      'alert_date, alert_type, severity, title, message, metric_name, metric_value, threshold_value, baseline_value, is_resolved, detected_at'
    )
    .eq('ad_account_id', activeAccount.account.id)
    .order('detected_at', { ascending: false })
    .limit(args.limit ?? 20)

  if (args.severity) query = query.eq('severity', args.severity)
  if (args.is_resolved !== undefined) query = query.eq('is_resolved', args.is_resolved)

  const { data, error } = await query
  if (error) throw new Error(`Alerts query failed: ${error.message}`)

  return {
    read_health: 'healthy' as const,
    alerts: (data || []).map((source) => {
      const a = projectDiagnosticAlert(source as Record<string, unknown>)
      return (
      sanitizeObject({
        date: a.alert_date,
        type: a.alert_type,
        severity: a.severity,
        title: a.title,
        message: a.message,
        metric: a.metric_name,
        value: a.metric_value,
        threshold: a.threshold_value,
        baseline: a.baseline_value,
        resolved: a.is_resolved,
        action_authority_tier: a.action_authority_tier,
      }))
    }),
    total: (data || []).length,
  }
}

export async function getAuditTasks(args: {
  status?: string
  priority?: string
  limit?: number
}) {
  checkRateLimit('get_audit_tasks')
  const db = getSupabaseClient()
  const activeAccount = await resolveOnlyActiveAccount(db)
  if (!activeAccount.ok) {
    throw new Error(`${activeAccountErrorCode(activeAccount.reason)}: audit tasks are unavailable because active account ownership is ${activeAccount.reason}`)
  }

  const requestedLimit = Math.min(Math.max(args.limit ?? 20, 1), 100)

  let query = db
    .from('audit_tasks')
    .select('id, title, description, recommendation, priority, status, due_date, created_at, action_decision:action_decisions(authority_tier, policy_version, authority_reason, owner_copy)')
    .eq('ad_account_id', activeAccount.account.id)
    .order('priority', { ascending: false })
    // Fetch a bounded audit window before filtering so legacy rows cannot crowd a current governed task
    // out of the requested live result.
    .limit(Math.min(Math.max(requestedLimit * 5, 100), 500))

  if (args.status) query = query.eq('status', args.status)
  if (args.priority) query = query.eq('priority', args.priority)

  const { data, error } = await query
  if (error) throw new Error(`Tasks query failed: ${error.message}`)

  const rows = (data || []) as Array<Record<string, unknown>>
  const allActionable = projectCurrentActionableTasks(rows)
  const actionable = allActionable.slice(0, requestedLimit)
  const actionableIds = new Set(allActionable.map((task) => String(task.id)))
  const historicalRecords = rows
    .filter((row) => !actionableIds.has(String(row.id)))
    .map((row) => ({ id: row.id, recorded_at: row.created_at ?? null }))

  return {
    read_health: 'healthy' as const,
    tasks: actionable.map((t) => (
      sanitizeObject({
        id: t.id,
        title: t.title,
        description: t.description,
        recommendation: t.recommendation,
        priority: t.priority,
        status: t.status,
        due_date: t.due_date,
        action_authority_tier: t.action_authority_tier,
      }))
    ),
    total: actionable.length,
    historical_records: historicalRecords,
    historical_record_count: historicalRecords.length,
  }
}
