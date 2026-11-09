import { getAdminClient } from '@/lib/supabase/admin'
import { runDriftCheck } from '@/lib/diagnostics/drift-check'
import { activeAccountErrorCode, resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

// MCP tool: on-demand warehouse-vs-live drift check. Answers "do the stored numbers still
// equal what Meta reports right now?" — the question underneath every past trust defect. Read-only; the
// nightly cron variant raises alerts, this one only reports.

export async function getDataDrift(): Promise<object> {
  const db = getAdminClient()
  const activeAccount = await resolveOnlyActiveAccount(db)
  if (!activeAccount.ok) return {
    error: `Data drift is unavailable because active account ownership is ${activeAccount.reason}.`,
    error_code: activeAccountErrorCode(activeAccount.reason),
    read_health: 'unavailable',
  }

  const report = await runDriftCheck(activeAccount.account.id, { raiseAlert: false })
  return {
    ...report,
    note:
      report.note +
      ' Live Meta account spend vs stored daily_insights AND the daily_reports rollups the dashboard reads, per day over the trailing complete week. ' +
      `Aligned = every layer within tolerance; drift names the worst day. This is spend-layer integrity — ${OW.many} truth still reconciles via get_reconciliation (GA4).`,
  }
}
