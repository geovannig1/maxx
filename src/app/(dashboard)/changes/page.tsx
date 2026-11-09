export const dynamic = 'force-dynamic'

import { requireOwner } from '@/lib/auth/page-owner'
import { getAdminClient } from '@/lib/supabase/admin'
import { ChangeReviewList, type ChangeRequest } from '@/components/changes/ChangeReviewList'
import { ProposeChangeForm } from '@/components/changes/ProposeChangeForm'
import type { WriteModeState } from '@/components/changes/ChangeApprovalCard'
import { PageHeader } from '@/components/layout/PageHeader'
import { GitPullRequest } from 'lucide-react'
import { activeAccountErrorCode, resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { ActiveAccountUnavailableNotice } from '@/components/accounts/ActiveAccountUnavailableNotice'
import { CHANGE_CARD_COLUMNS, listProposableDecisions, listRecentlyApplied, withStuckSince, type ProposableDecision } from '@/lib/writes/owner-change-reads'
import { isDemoMode } from '@/config/demo'

async function getPendingChanges(accountId: string): Promise<ChangeRequest[]> {
  const db = getAdminClient()
  // Approved-but-not-executed rows are loaded too — otherwise an approval whose execute step was lost
  // (network blip, page refresh, write mode off) disappears from this page and its apply control is
  // stranded. A campaign plan whose creation failed part-way is listed to resume or roll back (ADR-062).
  const [{ data }, { data: failedPlans }] = await Promise.all([
    db.from('change_requests').select(CHANGE_CARD_COLUMNS)
      .eq('ad_account_id', accountId)
      .in('status', ['pending', 'approved'])
      .order('created_at', { ascending: false })
      .limit(100),
    db.from('change_requests').select(CHANGE_CARD_COLUMNS)
      .eq('ad_account_id', accountId)
      .eq('status', 'failed').not('campaign_plan_version_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(20),
  ])
  // A run stuck holding the account lock is marked, so its card offers "Recover stuck change" (M1).
  return withStuckSince(db, accountId, [...(data ?? []), ...(failedPlans ?? [])] as unknown as ChangeRequest[])
}

const BANNER: Record<WriteModeState, { text: string; color: string; bg: string; border: string }> = {
  on: { text: 'WRITE MODE ON — approving a change will APPLY it live on Meta and may spend real money.', color: 'var(--danger)', bg: 'rgba(239,68,68,0.10)', border: 'rgba(239,68,68,0.35)' },
  off: { text: 'WRITE MODE OFF — approving records your decision; nothing runs on Meta until WRITE_MODE_ENABLED is on. Approved changes stay listed to apply later.', color: 'var(--success)', bg: 'rgba(52,211,153,0.08)', border: 'rgba(52,211,153,0.28)' },
  demo: { text: 'DEMO — approving runs a simulated executor on the sample data. Nothing is ever sent to Meta.', color: 'var(--warning)', bg: 'var(--warning-bg)', border: 'var(--warning-border)' },
}

export default async function ChangesPage({ searchParams }: { searchParams?: Promise<{ propose?: string }> } = {}) {
  await requireOwner()

  const db = getAdminClient()
  const activeAccount = await resolveOnlyActiveAccount(db)
  if (!activeAccount.ok) {
    return (
      <div className="space-y-5 max-w-3xl">
        <PageHeader
          title="Change lineage & review"
          icon={GitPullRequest}
          subtitle="Lineage, review detail, rollback plan, and execution status for governed change requests."
        />
        <ActiveAccountUnavailableNotice code={activeAccountErrorCode(activeAccount.reason)} />
      </div>
    )
  }
  const accountId = activeAccount.account.id
  const focus = (await searchParams)?.propose
  const [changes, applied, proposable] = await Promise.all([
    getPendingChanges(accountId), listRecentlyApplied(accountId), listProposableDecisions(accountId),
  ])
  const writeMode: WriteModeState = isDemoMode() ? 'demo' : process.env.WRITE_MODE_ENABLED === 'true' ? 'on' : 'off'
  const banner = BANNER[writeMode]
  const appliedRows = applied.ok ? applied.rows as ChangeRequest[] : []
  const listKey = [...changes, ...appliedRows].map((change) => `${change.id}:${change.status}`).join('|')

  return (
    <div className="space-y-5 max-w-3xl">
      <PageHeader
        title="Change lineage & review"
        icon={GitPullRequest}
        subtitle="Changes you approve: lineage, preview, evidence, risk, rollback plan and the verified result. Historical requests remain visible without action authority."
      />

      {/* Prominent, always-visible safety banner — the single most important context on this page. */}
      <div
        data-write-mode={writeMode}
        style={{
          display: 'flex', alignItems: 'center', gap: '10px',
          padding: '12px 16px', borderRadius: '10px', fontSize: '13px', fontWeight: 600,
          color: banner.color, background: banner.bg, border: `1px solid ${banner.border}`,
        }}
      >
        <span style={{ width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0, background: banner.color }} />
        {banner.text}
      </div>

      <ChangeReviewList key={listKey} initial={changes} applied={appliedRows} writeMode={writeMode} />
      {!applied.ok && <p className="text-[12px]" style={{ color: 'var(--warning)' }}>Recently applied changes are unavailable right now.</p>}

      <section className="space-y-3" aria-label="Propose a change from Maxx's decisions">
        <h2 className="section-label">Propose from Maxx&apos;s decisions</h2>
        <p className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
          Current decisions you can turn into a change: pause or activate an ad, set an ad set&apos;s daily budget, or duplicate an
          ad set as paused. Diagnostic-only observations are not listed. Every proposal is checked against the account currency,
          the daily budget ceiling and the per-change limit, and applies only after you approve it.
        </p>
        {focus && proposable.ok && !proposable.rows.some((decision) => decision.id === focus) && (
          <p data-propose-unavailable className="rounded-lg p-3 text-[12px]" style={{ color: 'var(--warning)', background: 'var(--warning-bg)', border: '1px solid var(--warning-border)' }}>
            The decision you picked cannot become a change here: it is not a pause, activate, ad-set budget or duplicate on an ad
            or ad set, it is no longer current, or it was already proposed (look for it above).
          </p>
        )}
        {!proposable.ok
          ? <p className="text-[12px]" style={{ color: 'var(--warning)' }}>Decisions are unavailable right now; nothing can be proposed until they load.</p>
          : proposable.rows.length === 0
            ? <p className="text-[13px]" style={{ color: 'var(--text-tertiary)' }}>No current decision can become a change right now.</p>
            : proposable.rows.map((decision: ProposableDecision) => (
              <ProposeChangeForm key={decision.id} decision={decision} highlighted={decision.id === focus} />
            ))}
      </section>
    </div>
  )
}
