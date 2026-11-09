export const dynamic = 'force-dynamic'

import { requireOwner } from '@/lib/auth/page-owner'
import { getAdminClient } from '@/lib/supabase/admin'
import { Rocket } from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { defaultManifest } from '@/lib/recommendations/manifest'
import { getLedgerForAccount, type LedgerRow } from '@/lib/recommendations/setup-ledger'
import { ManifestEditor } from '@/components/ledger/ManifestEditor'
import { ManualActionForm } from '@/components/ledger/ManualActionForm'
import { GovernedLaunchReadiness, launchReadinessChecks } from '@/components/ledger/GovernedLaunchReadiness'
import { loadPerformanceCockpitData } from '@/lib/cockpit/builder'
import { resolveRange } from '@/lib/date-range'
import type { PerformanceCockpitData } from '@/lib/cockpit/contracts'
import { READ_ONLY_APPLY_NOTE } from '@/lib/ui/proposal'
import { nyToday } from '@/lib/utils/date-utils'
import { resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { accountTimezone } from '@/config/business-config'

// Launch Setup (Ad Decision Ledger — Phases 4+5 surface). The pre-launch manifest: confirm every setting
// decision BEFORE going live, then log the manual launch/changes as they happen. Everything here records
// to the ledger only. This surface never calls the governed live-write path.

async function getData(): Promise<{ rows: LedgerRow[] }> {
  const db = getAdminClient()
  try {
    const activeAccount = await resolveOnlyActiveAccount(db)
    if (activeAccount.ok) return { rows: await getLedgerForAccount(activeAccount.account.id) }
  } catch {
    /* ledger unavailable — render with empty state; recording will surface the error */
  }
  return { rows: [] }
}

/** Source health for the last 7 complete days, from the same cockpit read the Truth page uses. A failed
 *  read is null, which the readiness checks report as "could not be read", never as a pass. */
async function getSourceHealth(): Promise<PerformanceCockpitData['sourceHealth'] | null> {
  try {
    return (await loadPerformanceCockpitData({ range: resolveRange({}, '1w') })).sourceHealth
  } catch {
    return null
  }
}

function fmtDate(iso: string): string {
  // Account TZ, not the render environment's: this is a server component (Vercel = UTC), so an
  // evening-ET timestamp would otherwise label as the NEXT day (audit F3).
  try { return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: accountTimezone() }) } catch { return iso }
}

export default async function LaunchPage() {
  await requireOwner()

  const [{ rows }, sourceHealth] = await Promise.all([getData(), getSourceHealth()])
  const setupRows = rows.filter((r) => r.origin === 'launch_setup')
  const manualRows = rows.filter((r) => r.origin === 'manual_action').slice(0, 20)

  return (
    <div className="space-y-4 max-w-3xl">
      <PageHeader
        title="Launch Setup"
        icon={Rocket}
        subtitle="Pre-launch checklist: record each setting decision and why, before going live — then log what you actually launched. One source of truth for 'why did we choose this setting?'"
      />

      <GovernedLaunchReadiness checks={launchReadinessChecks(sourceHealth)} />

      <div
        className="p-3"
        style={{ background: 'rgba(99,102,241,0.06)', border: '1px solid var(--border-focus)', borderRadius: '10px' }}
      >
        <p style={{ fontSize: '11.5px', color: 'var(--text-secondary)', margin: 0 }}>
          <span style={{ fontWeight: 700 }}>Recording a ledger decision here never touches Meta and is not an ActionDecision approval.</span> {READ_ONLY_APPLY_NOTE}
        </p>
      </div>

      <ManifestEditor defaults={defaultManifest(nyToday())} existing={setupRows} />

      <ManualActionForm />

      {manualRows.length > 0 && (
        <div className="card-base p-4">
          <p style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>Manual actions log</p>
          <div className="space-y-2" style={{ marginTop: '8px' }}>
            {manualRows.map((r) => (
              <div key={r.id} style={{ borderTop: '1px solid var(--border)', paddingTop: '8px' }}>
                <p style={{ fontSize: '12.5px', color: 'var(--text-primary)', margin: 0, fontWeight: 600 }}>
                  {r.setting_name}
                  {r.entity_name ? <span style={{ color: 'var(--text-tertiary)', fontWeight: 400 }}> · {r.entity_name}</span> : null}
                  <span style={{ color: 'var(--text-tertiary)', fontWeight: 400 }}> · {fmtDate(r.created_at)}</span>
                </p>
                <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                  {r.previous_value ? `${r.previous_value} → ` : ''}{r.actual_launched_value ?? r.final_value ?? '—'}
                  {r.conflicts_with_prior && !r.prior_deprecated && (
                    <span style={{ color: 'var(--warning)' }}> · ⚠ conflicts with a prior decision</span>
                  )}
                </p>
                {r.decision_note && (
                  <p style={{ fontSize: '11.5px', color: 'var(--text-tertiary)', marginTop: '2px' }}>“{r.decision_note}”</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
