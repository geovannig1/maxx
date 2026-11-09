export const dynamic = 'force-dynamic'

import { requireOwner } from '@/lib/auth/page-owner'
import { getAdminClient } from '@/lib/supabase/admin'
import { activeAccountErrorCode, resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { PageHeader } from '@/components/layout/PageHeader'
import { FileImage } from 'lucide-react'
import { StatePanel } from '@/components/ui/state-panel'

type BriefHistoryState =
  | { readHealth: 'healthy'; count: number }
  | { readHealth: 'unavailable'; errorCode: string }

async function getBriefHistory(): Promise<BriefHistoryState> {
  try {
    const db = getAdminClient()
    const activeAccount = await resolveOnlyActiveAccount(db)
    if (!activeAccount.ok) {
      return { readHealth: 'unavailable', errorCode: activeAccountErrorCode(activeAccount.reason) }
    }

    const { data, error, count } = await db
      .from('creative_briefs')
      .select('id', { count: 'exact' })
      .eq('ad_account_id', activeAccount.account.id)
      .order('created_at', { ascending: false })
      .limit(30)
    if (error) return { readHealth: 'unavailable', errorCode: 'LEGACY_BRIEF_HISTORY_UNAVAILABLE' }
    return { readHealth: 'healthy', count: count ?? data?.length ?? 0 }
  } catch {
    return { readHealth: 'unavailable', errorCode: 'LEGACY_BRIEF_HISTORY_UNAVAILABLE' }
  }
}

export default async function BriefsPage() {
  await requireOwner()

  const history = await getBriefHistory()

  return (
    <div className="owner-page owner-page-narrow">
      <div className="owner-surface owner-surface-section">
        <PageHeader
          title="Read-only legacy briefs"
          icon={FileImage}
          subtitle="Historical creative briefs are kept for audit context. They are not current launch instructions."
        />
      </div>

      <div className="owner-notice owner-warning">
        <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>Governed blocked status.</span>
        Current creative direction requires a verified, account-scoped campaign plan before Maxx can draft or reuse a brief.
      </div>

      <div className="owner-surface">
        {history.readHealth === 'healthy' ? (
          <StatePanel
            state="blocked"
            compact
            title={`${history.count} legacy brief${history.count === 1 ? '' : 's'} retained`}
            description="Strategy and execution details are intentionally withheld here. Nothing in this archive is current or actionable until governed launch context is verified."
          />
        ) : (
          <StatePanel
            state="unavailable"
            compact
            title="Legacy brief history unavailable"
            description={`The history read failed (${history.errorCode}). No empty or current-looking brief list is shown.`}
          />
        )}
      </div>
    </div>
  )
}
