export const dynamic = 'force-dynamic'

import { requireOwner } from '@/lib/auth/page-owner'
import { getAdminClient } from '@/lib/supabase/admin'
import { activeAccountErrorCode, resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { PageHeader } from '@/components/layout/PageHeader'
import { FlaskConical } from 'lucide-react'

/**
 * Experiments — the seventh and last destination of the IA ratified 2026-08-28 (design decision).
 *
 * Re-homed verbatim from `/performance/tests`, which stays as a redirect. The behaviour is unchanged
 * on purpose, including the part that looks like a gap: this page REFUSES to render a backlog.
 *
 * That refusal is the feature. The legacy `tests` rows are audit history, not a current experiment
 * queue, and nothing here becomes actionable until an immutable, account-scoped CampaignPlan exists
 * and is verified server-side. A destination that showed those rows as "experiments" would be a
 * decision engine pretending at a scale this account does not have. Promoting the page does not
 * promote its emptiness into a claim.
 */

type TestHistoryState =
  | { readHealth: 'healthy'; count: number }
  | { readHealth: 'unavailable'; errorCode: string }

async function getTestHistory(): Promise<TestHistoryState> {
  try {
    const db = getAdminClient()
    const activeAccount = await resolveOnlyActiveAccount(db)
    if (!activeAccount.ok) {
      return { readHealth: 'unavailable', errorCode: activeAccountErrorCode(activeAccount.reason) }
    }

    const { data, error, count } = await db
      .from('tests')
      .select('id', { count: 'exact' })
      .eq('ad_account_id', activeAccount.account.id)
      .order('created_at', { ascending: false })
      .limit(30)
    if (error) return { readHealth: 'unavailable', errorCode: 'LEGACY_TEST_HISTORY_UNAVAILABLE' }
    return { readHealth: 'healthy', count: count ?? data?.length ?? 0 }
  } catch {
    return { readHealth: 'unavailable', errorCode: 'LEGACY_TEST_HISTORY_UNAVAILABLE' }
  }
}

export default async function ExperimentsPage() {
  await requireOwner()

  const history = await getTestHistory()

  return (
    <div className="space-y-5 max-w-3xl">
      <PageHeader
        title="Experiments"
        icon={FlaskConical}
        subtitle="CAMPAIGN_PLAN_REQUIRED — legacy test rows are audit history, not a current experiment backlog."
      />

      <div className="card-base p-5 space-y-2">
        <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
          CAMPAIGN_PLAN_REQUIRED
        </p>
        {history.readHealth === 'healthy' ? (
          <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
            Legacy records retained for audit: {history.count}. Their strategy and execution details are withheld;
            nothing here is current or actionable until an immutable, account-scoped CampaignPlan is implemented
            and verified server-side.
          </p>
        ) : (
          <p className="text-xs" style={{ color: 'var(--danger)' }}>
            Legacy test history is unavailable ({history.errorCode}). No empty or current-looking backlog is shown.
          </p>
        )}
      </div>
    </div>
  )
}
